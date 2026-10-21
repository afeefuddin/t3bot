import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotError, isBotError } from "./config.ts";
import { serialize } from "./json.ts";
import {
  BotBridgeCommand,
  BotBridgePoll,
  BotBridgeReport,
  BotResponsibility,
} from "@t3tools/contracts/bot";
import * as Records from "./Records.ts";
import * as Tasks from "./Tasks.ts";
import * as Goals from "./Goals.ts";
const decodeBridgeCommand = Schema.decodeEffect(Schema.fromJsonString(BotBridgeCommand));
const terminal = new Set(["completed", "failed", "cancelled"]);
export class BridgeStore extends Context.Service<
  BridgeStore,
  {
    readonly poll: (
      id: string,
      hash: string,
      input: typeof BotBridgePoll.Type,
    ) => Effect.Effect<{ commands: ReadonlyArray<BotBridgeCommand> }, BotError>;
    readonly report: (
      id: string,
      hash: string,
      input: BotBridgeReport,
    ) => Effect.Effect<void, BotError>;
  }
>()("@t3tools/bot/BridgeStore") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { read, list, write, event, enqueue, append } = yield* Records.Records;
  const { get: requireTask, progress: taskProgress } = yield* Tasks.Tasks;
  const goals = yield* Goals.Goals;
  const authorized = Effect.fn("BotBridgeStore.authorized")(function* (id: string, hash: string) {
    const envs = yield* sql<{
      identity: string | null;
      last_seen: number;
      projects: string;
      providers: string;
      threads: string;
    }>`SELECT identity,last_seen,projects,providers,threads FROM environments WHERE id=${id} AND token_hash=${hash} AND revoked=0`;
    if (!envs[0]) return yield* new BotError({ category: "unauthorized" });
    return envs[0];
  });
  const poll = Effect.fn("BotBridgeStore.poll")(function* (
    id: string,
    hash: string,
    input: typeof BotBridgePoll.Type,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const env = yield* authorized(id, hash);
        if (env.identity && env.identity !== input.identity)
          return yield* new BotError({ category: "unauthorized" });
        const now = yield* Clock.currentTimeMillis;
        if (input.threads?.some((t) => !input.projects.some((p) => p.id === t.projectId)))
          return yield* new BotError({ category: "unauthorized" });
        const threadContext = serialize(input.threads ?? []);
        const providers = serialize(input.providers ?? []);
        yield* sql`UPDATE environments SET identity=${input.identity},last_seen=${now},projects=${serialize(input.projects)},providers=${providers},threads=${threadContext} WHERE id=${id}`;
        const reconnect = env.identity === null || env.last_seen < now - 30000;
        if (
          !reconnect &&
          (env.projects !== serialize(input.projects) ||
            env.providers !== providers ||
            env.threads !== threadContext)
        )
          yield* event("environments", now);
        if (reconnect) {
          yield* event("environments", now);
          for (const r of yield* list("responsibility", BotResponsibility, 1000))
            if (
              r.state === "active" &&
              r.schedule.type === "event" &&
              r.schedule.event === "environment_connected" &&
              (!r.environmentId || r.environmentId === id)
            )
              yield* enqueue(
                `connect:${r.id}:${r.revision}:${id}:${Math.floor(now / 30000)}`,
                "responsibility",
                { text: "", responsibilityId: r.id, revision: r.revision },
                now,
                r.id,
              );
        }
        const pending = yield* sql<{
          id: string;
          task_id: string;
        }>`SELECT id,task_id FROM bridge_commands WHERE environment_id=${id} AND state='pending' AND last_delivery=0`;
        for (const command of pending) {
          const task = yield* requireTask(command.task_id);
          if (!task.responsibilityId) continue;
          const r = yield* read("responsibility", task.responsibilityId, BotResponsibility);
          if (!r || r.state !== "active" || r.revision !== task.responsibilityRevision) {
            yield* sql`UPDATE bridge_commands SET state='done' WHERE id=${command.id}`;
            yield* write("task", task.id, 0, { ...task, status: "cancelled", updatedAt: now });
            yield* event("tasks", now);
          }
        }
        const rows = yield* sql<{
          id: string;
          data: string;
          task_id: string;
        }>`SELECT id,data,task_id FROM bridge_commands WHERE environment_id=${id} AND state='pending' AND last_delivery < ${now - 10000} ORDER BY rowid LIMIT 32`;
        const commands: BotBridgeCommand[] = [];
        for (const row of rows) {
          const command = yield* decodeBridgeCommand(row.data);
          const task = yield* requireTask(row.task_id);
          if (
            task.goalId &&
            ["start", "continue", "followup"].includes(command.kind) &&
            !["active", "verifying"].includes((yield* goals.get(task.goalId)).state)
          )
            continue;
          commands.push(command);
          yield* sql`UPDATE bridge_commands SET last_delivery=${now} WHERE id=${row.id}`;
          if (commands.length >= 4) break;
        }
        return { commands };
      }),
    );
  });
  const report = Effect.fn("BotBridgeStore.report")(function* (
    id: string,
    hash: string,
    input: BotBridgeReport,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorized(id, hash);
        const rows = yield* sql<{
          data: string;
          state: string;
        }>`SELECT data,state FROM bridge_commands WHERE id=${input.commandId} AND environment_id=${id} AND task_id=${input.taskId}`;
        if (!rows[0]) return yield* new BotError({ category: "not_found" });
        if (rows[0].state === "done") return;
        const command = yield* decodeBridgeCommand(rows[0].data);
        if (input.checks?.some((check) => check.runId !== input.runId))
          return yield* new BotError({ category: "invalid" });
        if (command.threadId !== input.threadId)
          return yield* new BotError({ category: "invalid" });
        const task = yield* requireTask(input.taskId);
        const now = yield* Clock.currentTimeMillis;
        if (!input.retryable)
          yield* sql`UPDATE bridge_commands SET state='done' WHERE id=${input.commandId}`;
        if (terminal.has(task.status) || command.generation !== task.generation) return;
        const next = {
          ...task,
          runId: input.runId ?? task.runId,
          status:
            task.status === "cancellation_requested" && !terminal.has(input.status)
              ? ("cancellation_requested" as const)
              : input.status,
          result: input.result.slice(0, 32000),
          checks: input.checks ?? [],
          updatedAt: now,
        };
        yield* write("task", task.id, 0, next);
        yield* event("tasks", now);
        yield* taskProgress(next, task);
        if (terminal.has(next.status)) {
          yield* append(
            `result:${task.id}:${next.runId ?? "none"}`,
            "system",
            `${task.title}: ${next.status}\n${next.result}`,
            task.id,
          );
          for (const r of yield* list("responsibility", BotResponsibility, 1000))
            if (
              task.responsibilityId === null &&
              r.state === "active" &&
              r.schedule.type === "event" &&
              r.schedule.event === "task_completed" &&
              r.id !== task.responsibilityId &&
              (!r.environmentId || r.environmentId === id)
            )
              yield* enqueue(
                `completed:${r.id}:${r.revision}:${task.id}`,
                "responsibility",
                { text: "", responsibilityId: r.id, revision: r.revision },
                now,
                r.id,
              );
        }
      }),
    );
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotError(cause) ? cause : new BotError({ category: "storage", cause }),
      ),
    );
  return BridgeStore.of({
    poll: (id, hash, input) => protect(poll(id, hash, input)),
    report: (id, hash, input) => protect(report(id, hash, input)),
  });
});
export const layer = Layer.effect(BridgeStore, make);
