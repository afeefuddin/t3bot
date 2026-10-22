import { codexCoordinatorInstructions, codexModelStepInstructions } from "./prompts.ts";
import type { BotChatMessage } from "@t3tools/contracts/bot";
import * as CodexClient from "effect-codex-app-server/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BotError, isBotError, type ProviderConfig } from "./config.ts";
import { serialize } from "./json.ts";
import type { BotTool } from "./Model.ts";

const Decision = Schema.Struct({
  content: Schema.NullOr(Schema.String),
  calls: Schema.Array(Schema.Struct({ name: Schema.String, arguments: Schema.String })).check(
    Schema.isMaxLength(4),
  ),
});
const decodeDecision = Schema.decodeUnknownEffect(Schema.fromJsonString(Decision));
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "calls"],
  properties: {
    content: { type: ["string", "null"] },
    calls: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments"],
        properties: { name: { type: "string" }, arguments: { type: "string" } },
      },
    },
  },
} satisfies Schema.Json;

// Return intentions to the durable coordinator; Codex never owns task or memory side effects.
const codexStep = Effect.fn("bot/codexStep")(function* (
  model: string,
  cwd: string,
  messages: ReadonlyArray<BotChatMessage>,
  tools: ReadonlyArray<BotTool>,
  webSearch = false,
) {
  const client = yield* CodexClient.CodexAppServerClient;
  const done = yield* Deferred.make<void, BotError>();
  let text = "";
  let tokens = 0;
  yield* client.handleServerNotification("item/completed", ({ item }) =>
    Effect.sync(() => {
      if (item.type === "agentMessage") text = item.text;
    }),
  );
  yield* client.handleServerNotification("thread/tokenUsage/updated", ({ tokenUsage }) =>
    Effect.sync(() => {
      tokens = tokenUsage.total.totalTokens;
    }),
  );
  yield* client.handleServerNotification("turn/completed", ({ turn }) =>
    turn.status === "completed"
      ? Deferred.succeed(done, undefined).pipe(Effect.asVoid)
      : Deferred.fail(done, new BotError({ category: "unavailable" })).pipe(Effect.asVoid),
  );
  yield* client.request("initialize", {
    clientInfo: { name: "t3bot", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  yield* client.notify("initialized", undefined);
  const started = yield* client.request("thread/start", {
    model,
    cwd,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: codexCoordinatorInstructions,
    developerInstructions: codexModelStepInstructions(model),
    config: {
      "features.shell_tool": false,
      "features.multi_agent": false,
      "features.hooks": false,
      "features.apps": false,
      "features.skip_host_skill_discovery": true,
      "features.unified_exec": false,
      "features.sleep_tool": false,
      "features.code_mode_host": false,
      "features.image_generation": false,
      "features.browser_use": false,
      "features.computer_use": false,
      "features.skill_search": false,
      web_search: webSearch ? "live" : "disabled",
    },
  });
  yield* client.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: serialize({ messages, tools }), text_elements: [] }],
    outputSchema,
  });
  yield* Deferred.await(done);
  const decision = yield* decodeDecision(text).pipe(
    Effect.mapError((cause) => new BotError({ category: "invalid", cause })),
  );
  if (
    (!decision.content && !decision.calls.length) ||
    decision.calls.some((call) => !tools.some((tool) => tool.function.name === call.name))
  )
    return yield* new BotError({ category: "invalid" });
  return {
    message: {
      role: "assistant" as const,
      content: decision.content,
      ...(decision.calls.length
        ? {
            tool_calls: decision.calls.map((call, i) => ({
              id: `codex-${i}`,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    },
    tokens: tokens || Math.ceil(serialize(messages).length / 3) + 4096,
  };
});

export const completeCodex = Effect.fn("bot/completeCodex")(
  function* (
    provider: Extract<ProviderConfig, { type: "codex" }>,
    messages: ReadonlyArray<BotChatMessage>,
    tools: ReadonlyArray<BotTool>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-coordinator-" });
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        provider.binary ?? "codex",
        ["app-server", "--disable", "hooks", "--disable", "apps", "-c", "mcp_servers={}"],
        { cwd },
      ),
    );
    return yield* codexStep(provider.model, cwd, messages, tools, provider.webSearch).pipe(
      Effect.provide(CodexClient.layerChildProcess(handle)),
      Effect.raceFirst(
        handle.exitCode.pipe(
          Effect.flatMap(() => Effect.fail(new BotError({ category: "unavailable" }))),
        ),
      ),
    );
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    isBotError(cause) ? cause : new BotError({ category: "unavailable", cause }),
  ),
  // An invalid model decision has not reached the host tool loop, so one fresh request is safe.
  Effect.retry({ times: 1, while: (error) => error.category === "invalid" }),
);
