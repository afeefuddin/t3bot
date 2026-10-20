import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  EnvironmentId,
  OrchestrationV2ThreadProjectionJson,
  ServerProvider,
} from "@t3tools/contracts";
import type { BotBridgeCommand } from "@t3tools/contracts/bot";
import * as Bridge from "./BotBridge.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";

const now = "2026-10-19T00:00:00.000Z";
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  showInteractionModeToggle: true,
  models: [
    { slug: "fixture", name: "Default", isCustom: false, capabilities: null },
    {
      slug: "custom-worker",
      name: "Custom worker",
      isCustom: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
});
const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson)({
  thread: {
    id: "task",
    projectId: "project",
    title: "Task",
    createdBy: "agent",
    creationSource: "server",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "task" },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
});
const command: BotBridgeCommand = {
  id: "c".repeat(160),
  taskId: "task",
  generation: 0,
  kind: "start",
  projectId: "project",
  threadId: "task",
  runId: null,
  text: "Work",
  title: "Task",
  isolated: true,
};

function harness(
  options: {
    allowed?: string;
    userThread?: boolean;
    missing?: boolean;
    noDefault?: boolean;
    unavailable?: boolean;
  } = {},
) {
  const launches: Launch.ThreadLaunchInput[] = [];
  const polls: Array<Record<string, unknown>> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.succeed([{ ...provider, enabled: !options.unavailable }]),
    }),
    Layer.mock(Adapters.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([provider.instanceId]),
    }),
    Layer.mock(Projects.ProjectStoreV2)({
      list: () =>
        Effect.succeed([
          {
            projectId: projection.thread.projectId,
            title: "Workspace",
            workspaceRoot: "/workspace",
            defaultModelSelection: options.noDefault ? null : projection.thread.modelSelection,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ]),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          const ceiling = yield* DispatchModeLimit;
          assert.equal(ceiling?.runtimeMode, "approval-required");
          launches.push(input);
          return { threadId: projection.thread.id, projection, resumed: launches.length > 1 };
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getProjectThread: (input) =>
        options.missing
          ? Effect.fail(new Threads.ThreadManagementThreadNotFoundError(input))
          : Effect.succeed(
              options.userThread
                ? { ...projection, thread: { ...projection.thread, createdBy: "user" as const } }
                : projection,
            ),
    }),
    Layer.mock(Environment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("native")),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag === "Uint8Array")
            polls.push(
              JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
            );
          return HttpClientResponse.fromWeb(request, Response.json({ commands: [] }));
        }),
      ),
    ),
  );
  const layer = Bridge.serviceLayer.pipe(
    Layer.provide(dependencies),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        T3BOT_URL: "https://bot.example",
        T3BOT_BRIDGE_ID: "grant".repeat(30),
        T3BOT_BRIDGE_PROJECT_IDS: options.allowed ?? "project",
      }),
    ),
  );
  return { layer, launches, polls };
}

it.effect("reconciles launch retries with stable IDs and the destination execution ceiling", () => {
  const h = harness();
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const first = yield* bridge.execute(command);
    yield* bridge.execute(command);
    assert.equal(first.status, "accepted");
    assert.equal(h.launches[0]?.commandId, h.launches[1]?.commandId);
    assert.equal(
      h.launches[0]?.initialMessage?.messageId,
      h.launches[1]?.initialMessage?.messageId,
    );
    assert.ok((h.launches[0]?.commandId.length ?? 0) < 160);
    assert.deepEqual(h.launches[0]?.workspaceStrategy, {
      type: "worktree",
      baseRef: "HEAD",
      startFromOrigin: false,
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "launches a bot-selected custom model with options and plan mode without a project default",
  () => {
    const h = harness({ noDefault: true });
    return Effect.gen(function* () {
      const bridge = yield* Bridge.BotBridge;
      yield* bridge.execute({
        ...command,
        modelSelection: {
          instanceId: provider.instanceId,
          model: "custom-worker",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        interactionMode: "plan",
      });
      assert.deepEqual(h.launches[0]?.modelSelection, {
        instanceId: provider.instanceId,
        model: "custom-worker",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      assert.equal(h.launches[0]?.interactionMode, "plan");
      yield* bridge.tick;
      assert.deepEqual(h.polls[0]?.projects, [{ id: "project", title: "Workspace" }]);
      assert.include(JSON.stringify(h.polls[0]?.providers), "custom-worker");
      assert.include(JSON.stringify(h.polls[0]?.providers), "reasoningEffort");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["model", "option", "disabled"])(
  "rejects a stale or unavailable %s before launch",
  (bad) => {
    const h = harness({ unavailable: bad === "disabled" });
    return Effect.gen(function* () {
      const bridge = yield* Bridge.BotBridge;
      const result = yield* bridge
        .execute({
          ...command,
          modelSelection: {
            instanceId: provider.instanceId,
            model: bad === "model" ? "invented" : "custom-worker",
            options: [{ id: "reasoningEffort", value: bad === "option" ? "invented" : "high" }],
          },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(h.launches.length, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("rejects a project outside the local grant before launching", () => {
  const h = harness({ allowed: "other" });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const result = yield* bridge.execute(command).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(h.launches.length, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("refuses to control an unrelated user thread", () => {
  const h = harness({ userThread: true });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const result = yield* bridge.execute({ ...command, kind: "followup" }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(h.layer));
});

it.effect("reconciles cancellation when a task never reached a persisted executor thread", () => {
  const h = harness({ missing: true });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    assert.equal((yield* bridge.execute({ ...command, kind: "cancel" })).status, "cancelled");
  }).pipe(Effect.provide(h.layer));
});
