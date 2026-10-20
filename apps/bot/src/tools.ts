import { BotCommand, type BotChatMessage } from "@t3tools/contracts/bot";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { BotError } from "./config.ts";
import type { BotTool } from "./Model.ts";
import * as Store from "./Store.ts";
import { environmentContext } from "./prompts.ts";

const object = (
  properties: Record<string, unknown>,
  required: ReadonlyArray<string> = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
export const tools: ReadonlyArray<BotTool> = [
  {
    type: "function",
    function: {
      name: "list_worker_models",
      description:
        "Discover the available provider instances, models, interaction modes and model options on an authorized environment. Use instanceId=null to list providers/models, or an exact instanceId to get that provider's model options. Choose the worker yourself for the objective; never invent model IDs.",
      parameters: object({ environmentId: text, instanceId: nullableText }),
    },
  },
  {
    type: "function",
    function: {
      name: "watch_task",
      description:
        "Set when the coordinator should wake to review an existing task, without creating a new task. afterMs is 60000 to 86400000, or null to stop timed checks. Completion and blocker events still wake the coordinator. Checks persist across restarts.",
      parameters: object({
        id: text,
        afterMs: { type: ["integer", "null"], minimum: 60000, maximum: 86400000 },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "forget_memory",
      description: "Forget a saved memory using its current revision.",
      parameters: object({ id: text, revision: { type: "integer" } }),
    },
  },
  {
    type: "function",
    function: {
      name: "run_responsibility",
      description: "Run an active responsibility now without changing its schedule.",
      parameters: object({ id: text }),
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_state",
      description:
        "Inspect available execution environments/projects, tasks, responsibilities and memories. Never invent IDs.",
      parameters: object({}),
    },
  },
  {
    type: "function",
    function: {
      name: "search_history",
      description: "Find earlier conversation messages by a phrase.",
      parameters: object({ query: text }),
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save a concise durable preference/fact. Scope user, environment:<id>, project:<environmentId>:<projectId>, or responsibility:<id>. Use a stable descriptive id and the current revision (0 for a new memory). Explicit is true only if the owner asked to remember this.",
      parameters: object({
        id: text,
        revision: { type: "integer" },
        scope: text,
        text,
        explicit: { type: "boolean" },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "start_task",
      description:
        "Start independent work in an authorized T3 environment/project. It returns immediately. Use an isolated worktree for code changes. You cannot claim completion until the actual result arrives.",
      parameters: object({
        title: text,
        instructions: text,
        environmentId: text,
        projectId: text,
        isolated: { type: "boolean" },
        modelSelection: object(
          {
            instanceId: text,
            model: text,
            options: {
              type: "array",
              items: object({ id: text, value: { type: ["string", "boolean"] } }),
            },
          },
          ["instanceId", "model"],
        ),
        interactionMode: { enum: ["default", "plan"] },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "followup_task",
      description:
        "Send follow-up instructions to the same task thread, or answer a question from its worker. Provider permission approvals still require opening the T3 thread.",
      parameters: object({ id: text, text }),
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_task",
      description:
        "Request cancellation of a task. A request is not confirmation the worker has stopped.",
      parameters: object({ id: text }),
    },
  },
  {
    type: "function",
    function: {
      name: "save_responsibility",
      description:
        "Save an ongoing responsibility or reminder. Schedule: {type:once,at:epochMillis}, {type:interval,everyMs:>=60000}, {type:daily,time:HH:mm,timezone:IANA,weekdays:[0..6]}, or {type:event,event:task_completed|environment_connected}. Set both environment/project IDs to null for a coordinator reminder. Use revision 0 for new records.",
      parameters: object({
        id: text,
        revision: { type: "integer" },
        title: text,
        instructions: text,
        environmentId: nullableText,
        projectId: nullableText,
        schedule: {
          anyOf: [
            object({ type: { const: "once" }, at: { type: "number" } }),
            object({ type: { const: "interval" }, everyMs: { type: "number", minimum: 60000 } }),
            object({
              type: { const: "daily" },
              time: text,
              timezone: text,
              weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
            }),
            object({
              type: { const: "event" },
              event: { enum: ["task_completed", "environment_connected"] },
            }),
          ],
        },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "set_responsibility_state",
      description: "Pause, resume (active), or archive a responsibility using its latest revision.",
      parameters: object({
        id: text,
        revision: { type: "integer" },
        state: { type: "string", enum: ["active", "paused", "archived"] },
      }),
    },
  },
];
export const silentTool: BotTool = {
  type: "function",
  function: {
    name: "complete_silently",
    description:
      "Finish this background wake without sending the owner a message when there is no useful update. Call alone, after any necessary tools. The persisted watch continues; do not send repetitive still-running messages.",
    parameters: object({}),
  },
};
const Arguments = Schema.Record(Schema.String, Schema.Unknown);
const decodeArguments = Schema.decodeEffect(Schema.fromJsonString(Arguments));
const decodeCommand = Schema.decodeUnknownEffect(BotCommand);

export const toolRunner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.Store;
  return Effect.fn("BotTools.invokeTool")(function* (
    call: NonNullable<BotChatMessage["tool_calls"]>[number],
    execution: {
      readonly job: Store.JobRow;
      readonly requestId: string;
      readonly messageId: string | undefined;
      readonly responsibilityId: string | undefined;
      readonly commit: (
        command: BotCommand,
      ) => Effect.Effect<unknown, BotError | Schema.SchemaError | SqlError>;
    },
  ) {
    if (
      execution.responsibilityId &&
      ["save_responsibility", "set_responsibility_state", "run_responsibility"].includes(
        call.function.name,
      )
    )
      return yield* new BotError({ category: "unauthorized" });
    const args = yield* decodeArguments(call.function.arguments);
    if (call.function.name === "complete_silently") return { silent: true };
    if (call.function.name === "inspect_state") {
      const current = yield* store.snapshot();
      return {
        environments: environmentContext(current),
        memories: current.memories,
        responsibilities: current.responsibilities,
        tasks: current.tasks.map((task) => ({ ...task, result: task.result.slice(0, 1000) })),
      };
    }
    if (call.function.name === "search_history")
      return yield* store.search(String(args.query ?? ""));
    if (call.function.name === "list_worker_models") {
      const env = (yield* store.snapshot()).environments.find(
        (e) => e.id === args.environmentId && !e.revoked,
      );
      if (!env) return yield* new BotError({ category: "unauthorized" });
      const providers = env.providers ?? [];
      return args.instanceId == null
        ? providers.map((p) => ({
            ...p,
            models: p.models.map((m) => ({ id: m.id, name: m.name })),
          }))
        : providers.filter((p) => p.instanceId === args.instanceId);
    }
    let command: unknown;
    switch (call.function.name) {
      case "remember": {
        if (
          !(yield* store.settings).autoMemory &&
          (args.explicit !== true || execution.job.kind === "memory_review")
        )
          return { skipped: "Automatic memory capture is disabled" };
        command = { ...args, type: "memory.save", source: execution.messageId ?? execution.job.id };
        break;
      }
      case "forget_memory":
        command = { ...args, type: "memory.forget" };
        break;
      case "run_responsibility":
        command = { ...args, type: "responsibility.run" };
        break;
      case "start_task": {
        const launched = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM receipts WHERE id LIKE ${`tool:${execution.job.id}:%`} AND json_extract(input,'$.type')='task.start'`;
        if ((launched[0]?.count ?? 0) >= 4) return yield* new BotError({ category: "budget" });
        command = { ...args, type: "task.start" };
        break;
      }
      case "followup_task":
        command = { ...args, type: "task.followup" };
        break;
      case "watch_task":
        command = { ...args, type: "task.watch" };
        break;
      case "cancel_task":
        command = { ...args, type: "task.cancel" };
        break;
      case "save_responsibility":
        command = { ...args, type: "responsibility.save" };
        break;
      case "set_responsibility_state":
        command = { ...args, type: "responsibility.state" };
        break;
      default:
        return yield* new BotError({ category: "invalid" });
    }
    const decoded = yield* decodeCommand({
      ...(command as Record<string, unknown>),
      requestId: execution.requestId,
    });
    return yield* execution.commit(decoded);
  });
});
