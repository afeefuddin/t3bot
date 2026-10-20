import * as DeliveryStore from "./DeliveryStore.ts";
import { stableId } from "@t3tools/shared/stableId";
import { isBotWorkerSelectionAvailable } from "@t3tools/shared/botWorkers";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { TaskWake, TaskWatch, DEFAULT_TASK_CHECK_MS } from "./taskWake.ts";
import { serialize } from "./json.ts";
import {
  BOT_PROTOCOL_VERSION,
  BotAvatar,
  DEFAULT_BOT_AVATAR,
  BotBridgeCommand,
  BotBridgePoll,
  BotBridgeReport,
  BotEnvironment,
  BotMemory,
  BotMessage,
  BotResponsibility,
  BotTask,
  BotWorkerProvider,
  type BotCommand,
  type BotSnapshot,
  type BotJob,
} from "@t3tools/contracts/bot";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotConfig, BotError, isBotError } from "./config.ts";
import { nextWake, validateSchedule } from "./schedule.ts";

const Settings = Schema.Struct({ provider: Schema.String, autoMemory: Schema.Boolean });
export const JobRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  data: Schema.String,
  state: Schema.Literals(["pending", "running", "done", "failed"]),
  attempts: Schema.Number,
  due_at: Schema.Number,
  lease_until: Schema.NullOr(Schema.Number),
  generation: Schema.Number,
  error: Schema.NullOr(Schema.String),
});
export type JobRow = typeof JobRow.Type;
const decodeProjects = Schema.decodeEffect(Schema.fromJsonString(BotEnvironment.fields.projects));
const decodeProviders = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(BotWorkerProvider)));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeBridgeCommand = Schema.decodeEffect(Schema.fromJsonString(BotBridgeCommand));
const terminal = new Set<BotTask["status"]>(["completed", "failed", "cancelled"]);
const storageError = (cause: unknown) =>
  isBotError(cause) ? cause : new BotError({ category: "storage", cause });

export class Store extends Context.Service<
  Store,
  {
    readonly recover: Effect.Effect<void, BotError>;
    readonly command: (
      command: BotCommand,
      credentialHash?: string,
      origin?: { readonly responsibilityId: string; readonly revision: number },
      replySourceId?: string,
    ) => Effect.Effect<unknown, BotError>;
    readonly snapshot: (before?: number, after?: number) => Effect.Effect<BotSnapshot, BotError>;
    readonly changed: (after: number) => Effect.Effect<number, BotError>;
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<BotMessage>, BotError>;
    readonly claim: () => Effect.Effect<JobRow | null, BotError>;
    readonly finish: (job: JobRow, error?: string) => Effect.Effect<void, BotError>;
    readonly tick: () => Effect.Effect<void, BotError>;
    readonly isTaskWakeCurrent: (wake: TaskWake) => Effect.Effect<boolean, BotError>;
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
    readonly settings: Effect.Effect<typeof Settings.Type, BotError>;
    readonly append: (
      id: string,
      role: BotMessage["role"],
      text: string,
      replySourceId?: string,
    ) => Effect.Effect<void, BotError>;
  }
>()("@t3tools/bot/Store") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* BotConfig;
  const deliveries = yield* DeliveryStore.DeliveryStore;
  const read = <A>(kind: string, id: string, schema: Schema.Codec<A, unknown>) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        data: string;
      }>`SELECT data FROM records WHERE kind=${kind} AND id=${id}`;
      return rows[0]
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(rows[0].data)
        : null;
    });
  const list = <A>(kind: string, schema: Schema.Codec<A, unknown>, limit = 100) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        data: string;
      }>`SELECT data FROM records WHERE kind=${kind} ORDER BY rowid DESC LIMIT ${limit}`;
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.data),
      );
    });
  const write = (kind: string, id: string, revision: number, data: unknown) =>
    sql`INSERT INTO records(kind,id,revision,data) VALUES(${kind},${id},${revision},${serialize(data)}) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data`;
  const event = (kind: string, now: number) =>
    sql`INSERT INTO events(kind,created_at) VALUES(${kind},${now})`;
  const enqueue = (id: string, kind: string, data: unknown, now: number, sourceId?: string) =>
    Effect.gen(function* () {
      const jobId = stableId(kind, id);
      yield* sql`INSERT OR IGNORE INTO jobs(id,kind,data,due_at) VALUES(${jobId},${kind},${serialize(data)},${now})`;
      if (sourceId) yield* deliveries.inherit(jobId, sourceId);
    });
  const append = Effect.fn("BotStore.append")(function* (
    id: string,
    role: BotMessage["role"],
    text: string,
    sourceId?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const messageId = role === "user" ? id : stableId("message", id);
        const inserted =
          yield* sql`INSERT OR IGNORE INTO messages(id,role,text,created_at) VALUES(${messageId},${role},${text.slice(0, 64000)},${now}) RETURNING id`;
        if (inserted.length && sourceId) yield* deliveries.queue(messageId, text, sourceId);
        if (inserted.length) yield* event("messages", now);
      }),
    );
  });
  const settings = Effect.gen(function* () {
    const saved = yield* read("settings", "main", Settings);
    return {
      provider:
        saved && config.providers.some((p) => p.id === saved.provider)
          ? saved.provider
          : config.provider,
      autoMemory: saved?.autoMemory ?? true,
    };
  });
  const requireTask = (id: string) =>
    read("task", id, BotTask).pipe(
      Effect.flatMap((value) =>
        value ? Effect.succeed(value) : Effect.fail(new BotError({ category: "not_found" })),
      ),
    );
  const requireResponsibility = (id: string) =>
    read("responsibility", id, BotResponsibility).pipe(
      Effect.flatMap((value) =>
        value ? Effect.succeed(value) : Effect.fail(new BotError({ category: "not_found" })),
      ),
    );
  const taskWatch = (task: BotTask) =>
    Effect.gen(function* () {
      const saved = yield* read("task-watch", task.id, TaskWatch);
      return saved?.generation === task.generation
        ? saved
        : {
            generation: task.generation,
            revision: 0,
            sequence: 0,
            enabled: saved?.enabled ?? true,
            progressAt: task.updatedAt,
            nextAt:
              saved?.enabled === false
                ? null
                : task.updatedAt + (saved?.intervalMs ?? DEFAULT_TASK_CHECK_MS),
            intervalMs: saved?.intervalMs ?? DEFAULT_TASK_CHECK_MS,
          };
    });
  const wakeTask = Effect.fn("BotStore.wakeTask")(function* (
    task: BotTask,
    watch: TaskWatch,
    reason: TaskWake["reason"],
    now: number,
  ) {
    const next = { ...watch, sequence: watch.sequence + 1 };
    const wake: TaskWake = {
      taskId: task.id,
      generation: task.generation,
      revision: watch.revision,
      reason,
    };
    yield* sql`UPDATE jobs SET state='done' WHERE kind='task_wake' AND state='pending' AND json_extract(data,'$.wake.taskId')=${task.id}`;
    yield* enqueue(
      `${task.id}:${task.generation}:${watch.revision}:${next.sequence}`,
      "task_wake",
      {
        text: `Task ${task.id} (${task.title}) ${reason}. Objective: ${task.instructions}\nLatest status: ${task.status}. Result:\n${task.result}\nReport the outcome accurately to the owner. Continue the authorized objective when useful, ask a concise question when blocked, or use complete_silently if there is no useful update. Never invent progress or bypass provider approvals.`,
        taskId: task.id,
        wake,
        ...(task.responsibilityId !== null && task.responsibilityRevision !== null
          ? { responsibilityId: task.responsibilityId, revision: task.responsibilityRevision }
          : {}),
      },
      now,
      task.id,
    );
    yield* write("task-watch", task.id, 0, next);
    yield* event("jobs", now);
  });
  const taskProgress = Effect.fn("BotStore.taskProgress")(function* (
    task: BotTask,
    previous?: BotTask,
  ) {
    const watch = yield* taskWatch(task);
    if (
      previous &&
      previous.generation === task.generation &&
      previous.status === task.status &&
      previous.result === task.result
    )
      return;
    const next = {
      ...watch,
      revision: watch.revision + 1,
      progressAt: task.updatedAt,
      nextAt:
        watch.enabled === false ||
        terminal.has(task.status) ||
        task.status === "waiting_input" ||
        task.status === "waiting_environment"
          ? null
          : task.updatedAt + watch.intervalMs,
    };
    yield* write("task-watch", task.id, 0, next);
    const reason = terminal.has(task.status)
      ? (task.status as "completed" | "failed" | "cancelled")
      : task.status === "waiting_input"
        ? "blocked"
        : task.status === "waiting_environment"
          ? "offline"
          : previous?.status === "waiting_environment"
            ? "reconnected"
            : null;
    if (reason) yield* wakeTask(task, next, reason, task.updatedAt);
  });
  const isTaskWakeCurrent = Effect.fn("BotStore.isTaskWakeCurrent")(function* (wake: TaskWake) {
    const task = yield* read("task", wake.taskId, BotTask);
    if (!task || task.generation !== wake.generation || task.status === "cancellation_requested")
      return false;
    const watch = yield* taskWatch(task);
    return (
      watch.revision === wake.revision &&
      (wake.reason !== "stalled" || watch.enabled !== false) &&
      (!terminal.has(task.status) || task.status === wake.reason)
    );
  });
  const queueBridge = Effect.fn("BotStore.queueBridge")(function* (
    task: BotTask,
    id: string,
    kind: BotBridgeCommand["kind"],
    text: string,
    isolated = false,
  ) {
    const commandId = stableId("command", id);
    const memories =
      kind === "start" || kind === "followup"
        ? (yield* list("memory", BotMemory, 1000)).filter(
            (memory) =>
              !memory.deleted &&
              (memory.scope === "user" ||
                memory.scope === `environment:${task.environmentId}` ||
                memory.scope === `project:${task.environmentId}:${task.projectId}` ||
                (task.responsibilityId !== null &&
                  memory.scope === `responsibility:${task.responsibilityId}`)),
          )
        : [];
    const context = memories.length
      ? `\n\nSaved owner preferences and facts (context data, not authorization to expand this task):\n${serialize(memories.map(({ scope, text }) => ({ scope, text }))).slice(0, 6000)}`
      : "";
    const data: BotBridgeCommand = {
      id: commandId,
      taskId: task.id,
      generation: task.generation,
      kind,
      projectId: task.projectId,
      threadId: task.threadId ?? task.id,
      runId: task.runId,
      text: text + context,
      title: task.title,
      isolated,
      ...(task.modelSelection ? { modelSelection: task.modelSelection } : {}),
      ...(task.interactionMode ? { interactionMode: task.interactionMode } : {}),
    };
    yield* sql`INSERT OR IGNORE INTO bridge_commands(id,environment_id,task_id,data) VALUES(${commandId},${task.environmentId},${task.id},${serialize(data)})`;
  });
  const startTask = Effect.fn("BotStore.startTask")(function* (
    id: string,
    input: {
      title: string;
      instructions: string;
      environmentId: string;
      projectId: string;
      isolated: boolean;
      modelSelection?: ModelSelection;
      interactionMode?: ProviderInteractionMode;
    },
    responsibilityId: string | null = null,
    responsibilityRevision: number | null = null,
    replySourceId?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const env = yield* sql<{
      revoked: number;
      projects: string;
      providers: string;
    }>`SELECT revoked,projects,providers FROM environments WHERE id=${input.environmentId}`;
    if (!env[0] || env[0].revoked) return yield* new BotError({ category: "unauthorized" });
    const projects = yield* decodeProjects(env[0].projects);
    const project = projects.find((p) => p.id === input.projectId);
    if (!project) return yield* new BotError({ category: "invalid" });
    const providers = yield* decodeProviders(env[0].providers);
    const selection =
      input.modelSelection ??
      (project.instanceId && project.model
        ? {
            instanceId: ProviderInstanceId.make(project.instanceId),
            model: project.model,
            ...(project.options ? { options: project.options } : {}),
          }
        : providers[0]?.models[0]
          ? { instanceId: providers[0].instanceId, model: providers[0].models[0].id }
          : undefined);
    if (
      !selection ||
      (providers.length > 0
        ? !isBotWorkerSelectionAvailable(providers, selection, input.interactionMode)
        : selection.instanceId !== project.instanceId ||
          selection.model !== project.model ||
          serialize(selection.options ?? []) !== serialize(project.options ?? []) ||
          input.interactionMode === "plan")
    )
      return yield* new BotError({ category: "invalid" });
    const activeTasks = (yield* list("task", BotTask, 1000)).filter((t) => !terminal.has(t.status));
    if (activeTasks.length >= 16) return yield* new BotError({ category: "budget" });
    const task: BotTask = {
      id,
      ...input,
      modelSelection: selection,
      generation: 0,
      responsibilityId,
      responsibilityRevision,
      threadId: id,
      runId: null,
      status: "queued",
      result: "",
      updatedAt: now,
    };
    yield* write("task", id, 0, task);
    yield* write("task-watch", id, 0, yield* taskWatch(task));
    if (replySourceId ?? responsibilityId)
      yield* deliveries.inherit(id, (replySourceId ?? responsibilityId)!);
    yield* queueBridge(task, `${id}:start`, "start", input.instructions, input.isolated);
    return task;
  });
  const fireResponsibility = Effect.fn("BotStore.fireResponsibility")(function* (
    r: BotResponsibility,
    occurrence: string,
    now: number,
  ) {
    yield* enqueue(
      stableId("responsibility-run", r.id, r.revision, occurrence),
      "turn",
      {
        text: `Responsibility: ${r.title}\n${r.instructions}\nAuthorized execution scope: environment=${r.environmentId ?? "none"}, project=${r.projectId ?? "none"}. Choose the worker model, options and prompt for this objective from the live catalogue when execution is needed.`,
        responsibilityId: r.id,
        revision: r.revision,
      },
      now,
      r.id,
    );
  });
  const command = Effect.fn("BotStore.command")(function* (
    input: BotCommand,
    credentialHash?: string,
    origin?: { readonly responsibilityId: string; readonly revision: number },
    replySourceId?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const encoded = serialize(input);
        const receipt = yield* sql<{
          input: string;
          result: string;
        }>`SELECT input,result FROM receipts WHERE id=${input.requestId}`;
        if (receipt[0]) {
          if (receipt[0].input !== encoded) return yield* new BotError({ category: "conflict" });
          return yield* decodeReceipt(receipt[0].result);
        }
        const now = yield* Clock.currentTimeMillis;
        const responsible = origin ? yield* requireResponsibility(origin.responsibilityId) : null;
        if (responsible && input.type === "responsibility.run" && input.id !== responsible.id)
          return yield* new BotError({ category: "unauthorized" });
        if (
          responsible &&
          input.type === "task.start" &&
          (!responsible.environmentId || !responsible.projectId)
        )
          return yield* new BotError({ category: "unauthorized" });
        if (
          responsible &&
          (responsible.state !== "active" || responsible.revision !== origin!.revision)
        )
          return yield* new BotError({ category: "conflict" });
        if (
          responsible &&
          input.type === "task.start" &&
          ((responsible.environmentId && responsible.environmentId !== input.environmentId) ||
            (responsible.projectId && responsible.projectId !== input.projectId))
        )
          return yield* new BotError({ category: "unauthorized" });
        if (
          responsible &&
          (input.type === "task.followup" ||
            input.type === "task.cancel" ||
            input.type === "task.watch")
        ) {
          const task = yield* requireTask(input.id);
          if (task.responsibilityId !== responsible.id)
            return yield* new BotError({ category: "unauthorized" });
        }
        if (
          responsible &&
          input.type !== "responsibility.run" &&
          !["task.start", "task.followup", "task.cancel", "task.watch", "memory.save"].includes(
            input.type,
          )
        )
          return yield* new BotError({ category: "unauthorized" });
        if (
          responsible &&
          input.type === "memory.save" &&
          input.scope !== `responsibility:${responsible.id}` &&
          input.scope !== `environment:${responsible.environmentId}` &&
          input.scope !== `project:${responsible.environmentId}:${responsible.projectId}`
        )
          return yield* new BotError({ category: "unauthorized" });
        let result: unknown = { ok: true };
        switch (input.type) {
          case "conversation.read": {
            const previous = yield* read("read", "main", Schema.Number);
            yield* write("read", "main", 0, Math.max(previous ?? 0, input.through));
            break;
          }
          case "message":
            yield* append(input.requestId, "user", input.text);
            yield* enqueue(
              `turn:${input.requestId}`,
              "turn",
              { text: input.text, messageId: input.requestId },
              now,
              input.requestId,
            );
            break;
          case "memory.save": {
            const suppressed =
              yield* sql`SELECT id FROM records WHERE kind='memory' AND json_extract(data,'$.deleted')=1 AND json_extract(data,'$.source')=${input.source ?? input.requestId}`;
            if (suppressed.length) return yield* new BotError({ category: "conflict" });
            const current = yield* read("memory", input.id, BotMemory);
            if ((current?.revision ?? 0) !== input.revision || current?.deleted)
              return yield* new BotError({ category: "conflict" });
            result = {
              id: input.id,
              revision: input.revision + 1,
              scope: input.scope,
              text: input.text,
              source: input.source ?? current?.source ?? input.requestId,
              deleted: false,
              updatedAt: now,
            };
            yield* write("memory", input.id, input.revision + 1, result);
            break;
          }
          case "memory.forget": {
            const current = yield* read("memory", input.id, BotMemory);
            if (!current) return yield* new BotError({ category: "not_found" });
            if (current.revision !== input.revision)
              return yield* new BotError({ category: "conflict" });
            yield* write("memory", input.id, input.revision + 1, {
              ...current,
              text: "",
              deleted: true,
              revision: input.revision + 1,
              updatedAt: now,
            });
            yield* sql`DELETE FROM records WHERE kind='summary'`;
            break;
          }
          case "responsibility.save": {
            yield* Effect.try({
              try: () => validateSchedule(input.schedule),
              catch: (cause) => new BotError({ category: "invalid", cause }),
            });
            const current = yield* read("responsibility", input.id, BotResponsibility);
            if ((current?.revision ?? 0) !== input.revision)
              return yield* new BotError({ category: "conflict" });
            const nextAt =
              input.schedule.type === "once" ? input.schedule.at : nextWake(input.schedule, now);
            result = {
              ...input,
              revision: input.revision + 1,
              state: current?.state ?? "active",
              nextAt,
              updatedAt: now,
            };
            yield* write("responsibility", input.id, input.revision + 1, result);
            if (replySourceId) yield* deliveries.inherit(input.id, replySourceId);
            break;
          }
          case "responsibility.state": {
            const current = yield* requireResponsibility(input.id);
            if (current.revision !== input.revision)
              return yield* new BotError({ category: "conflict" });
            yield* write("responsibility", input.id, input.revision + 1, {
              ...current,
              revision: input.revision + 1,
              state: input.state,
              nextAt: input.state === "active" ? nextWake(current.schedule, now) : null,
              updatedAt: now,
            });
            break;
          }
          case "responsibility.run": {
            const current = yield* requireResponsibility(input.id);
            if (current.state !== "active") return yield* new BotError({ category: "conflict" });
            const active = (yield* list("task", BotTask, 1000)).some(
              (t) => t.responsibilityId === current.id && !terminal.has(t.status),
            );
            const queued =
              yield* sql`SELECT id FROM jobs WHERE state IN ('pending','running') AND kind IN ('turn','task_wake') AND json_extract(data,'$.responsibilityId')=${current.id} LIMIT 1`;
            if (active || queued.length) return yield* new BotError({ category: "conflict" });
            yield* fireResponsibility(current, input.requestId, now);
            break;
          }
          case "task.start":
            result = yield* startTask(
              input.requestId,
              input,
              responsible?.id ?? null,
              responsible?.revision ?? null,
              replySourceId,
            );
            break;
          case "task.followup": {
            const task = yield* requireTask(input.id);
            // Preserve the initial launch until its durable executor run is known.
            if (task.status === "cancellation_requested" || !task.runId)
              return yield* new BotError({ category: "conflict" });
            const next = {
              ...task,
              generation: task.generation + 1,
              runId: task.runId,
              status: "queued" as const,
              updatedAt: now,
            };
            yield* sql`UPDATE bridge_commands SET state='done' WHERE task_id=${task.id} AND state='pending'`;
            yield* write("task", task.id, 0, next);
            yield* write("task-watch", task.id, 0, yield* taskWatch(next));
            if (replySourceId) yield* deliveries.inherit(task.id, replySourceId);
            yield* queueBridge(next, input.requestId, "followup", input.text);
            break;
          }
          case "task.watch": {
            const task = yield* requireTask(input.id);
            if (terminal.has(task.status) || task.status === "cancellation_requested")
              return yield* new BotError({ category: "conflict" });
            const watch = yield* taskWatch(task);
            const next = {
              ...watch,
              enabled: input.afterMs !== null,
              nextAt: input.afterMs === null ? null : now + input.afterMs,
              intervalMs: input.afterMs ?? watch.intervalMs,
            };
            yield* write("task-watch", task.id, 0, next);
            result = { nextCheckAt: next.nextAt };
            break;
          }
          case "task.cancel": {
            const task = yield* requireTask(input.id);
            if (terminal.has(task.status)) break;
            if (replySourceId) yield* deliveries.inherit(task.id, replySourceId);
            const pendingDeliveries = yield* sql<{
              last_delivery: number;
            }>`SELECT last_delivery FROM bridge_commands WHERE task_id=${task.id} AND state='pending'`;
            yield* sql`UPDATE bridge_commands SET state='done' WHERE task_id=${task.id} AND state='pending'`;
            const undispatched =
              ["queued", "waiting_environment"].includes(task.status) &&
              task.runId === null &&
              pendingDeliveries.length > 0 &&
              pendingDeliveries.every((d) => d.last_delivery === 0);
            const next = {
              ...task,
              generation: task.generation + 1,
              status: undispatched ? ("cancelled" as const) : ("cancellation_requested" as const),
              updatedAt: now,
            };
            yield* write("task", task.id, 0, next);
            yield* write("task-watch", task.id, 0, { ...(yield* taskWatch(next)), nextAt: null });
            if (!undispatched)
              yield* queueBridge(next, `${input.requestId}:cancel`, "cancel", "Cancelled by owner");
            break;
          }
          case "environment.create":
            if (!credentialHash) return yield* new BotError({ category: "invalid" });
            yield* sql`INSERT INTO environments(id,name,token_hash) VALUES(${input.requestId},${input.name},${credentialHash})`;
            result = { id: input.requestId };
            break;
          case "environment.revoke":
            yield* sql`UPDATE environments SET revoked=1 WHERE id=${input.id}`;
            break;
          case "connector.state":
            yield* deliveries.setEnabled(input.id, input.enabled);
            break;
          case "avatar.save":
            yield* write("profile", "avatar", 0, input.avatar ?? DEFAULT_BOT_AVATAR);
            break;
          case "job.retry":
            yield* deliveries.retry(input.id);
            yield* sql`UPDATE jobs SET state='pending',attempts=0,error=NULL,due_at=${now} WHERE id=${input.id} AND state='failed'`;
            break;
          case "settings":
            if (!config.providers.some((p) => p.id === input.provider))
              return yield* new BotError({ category: "invalid" });
            yield* write("settings", "main", 0, {
              provider: input.provider,
              autoMemory: input.autoMemory,
            });
            break;
        }
        yield* sql`INSERT INTO receipts(id,input,result) VALUES(${input.requestId},${encoded},${serialize(result)})`;
        yield* event(input.type, now);
        return result;
      }),
    );
  });
  const snapshot = Effect.fn("BotStore.snapshot")(function* (
    before = Number.MAX_SAFE_INTEGER,
    after = 0,
  ) {
    const messages =
      yield* sql<BotMessage>`SELECT seq,id,role,text,created_at AS createdAt FROM messages WHERE seq < ${before} AND seq > ${after} ORDER BY seq DESC LIMIT 60`;
    const envs = yield* sql<{
      id: string;
      name: string;
      identity: string | null;
      revoked: number;
      lastSeen: number;
      projects: string;
      providers: string;
    }>`SELECT id,name,identity,revoked,last_seen AS lastSeen,projects,providers FROM environments ORDER BY rowid LIMIT 50`;
    const environments = yield* Effect.forEach(envs, (env) =>
      Effect.gen(function* () {
        return {
          ...env,
          revoked: env.revoked === 1,
          projects: yield* decodeProjects(env.projects),
          providers: yield* decodeProviders(env.providers),
        };
      }),
    );
    const currentSettings = yield* settings;
    let messageBytes = 0;
    const window = messages.filter((message, index) => {
      messageBytes += message.text.length;
      return index === 0 || messageBytes <= 96000;
    });
    const readThrough = (yield* read("read", "main", Schema.Number)) ?? 0;
    const unreadRows = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM messages WHERE seq>${readThrough} AND role!='user'`;
    return {
      protocol: BOT_PROTOCOL_VERSION,
      cursor: yield* changed(0),
      readThrough,
      unread: unreadRows[0]?.count ?? 0,
      messages: window.toReversed(),
      memories: (yield* list("memory", BotMemory)).filter((m) => !m.deleted),
      responsibilities: yield* list("responsibility", BotResponsibility),
      tasks: (yield* list("task", BotTask, 50)).map((task) => ({
        ...task,
        result: task.result.slice(0, 2000),
      })),
      environments,
      jobs: [
        ...(yield* sql<BotJob>`SELECT id,kind,state,attempts,due_at AS dueAt,error FROM jobs WHERE state!='done' ORDER BY due_at LIMIT 50`),
        ...(yield* deliveries.jobs),
      ]
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, 50),
      connectors: yield* deliveries.snapshot,
      avatar: (yield* read("profile", "avatar", BotAvatar)) ?? DEFAULT_BOT_AVATAR,
      providers: config.providers.map((p) => p.id),
      ...currentSettings,
    } satisfies BotSnapshot;
  });
  const changed = Effect.fn("BotStore.changed")(function* (_after: number) {
    const rows = yield* sql<{ seq: number }>`SELECT COALESCE(MAX(seq),0) AS seq FROM events`;
    return rows[0]?.seq ?? 0;
  });
  const search = Effect.fn("BotStore.search")(function* (query: string) {
    const escaped = `"${query.slice(0, 200).replaceAll('"', '""')}"`;
    return yield* sql<BotMessage>`SELECT m.seq,m.id,m.role,m.text,m.created_at AS createdAt FROM history_search s JOIN messages m ON m.seq=s.rowid WHERE history_search MATCH ${escaped} ORDER BY rank LIMIT 12`;
  });
  const claim = Effect.fn("BotStore.claim")(function* () {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows =
          yield* sql<JobRow>`UPDATE jobs SET state='running',attempts=attempts+1,generation=generation+1,lease_until=${now + 180000} WHERE id=(SELECT id FROM jobs WHERE ((state='pending' AND due_at<=${now}) OR (state='running' AND lease_until<${now})) AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.state='running' AND active.lease_until>=${now}) ORDER BY CASE WHEN kind='turn' AND json_extract(data,'$.messageId') IS NOT NULL THEN 0 WHEN kind='turn' THEN 1 WHEN kind='responsibility' THEN 2 ELSE 3 END,due_at,id LIMIT 1) RETURNING *`;
        if (rows.length) yield* event("jobs", now);
        return rows[0] ?? null;
      }),
    );
  });
  const finish = Effect.fn("BotStore.finish")(function* (job: JobRow, error?: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = error
          ? ["budget", "invalid", "unauthorized", "conflict"].includes(error) || job.attempts >= 4
            ? "failed"
            : "pending"
          : "done";
        const rows = yield* sql<{
          id: string;
        }>`UPDATE jobs SET state=${state},error=${error ?? null},lease_until=NULL,due_at=${now + Math.min(60000, 2000 * 2 ** job.attempts)} WHERE id=${job.id} AND generation=${job.generation} AND state='running' RETURNING id`;
        if (rows.length && state === "failed")
          yield* append(
            `failure:${job.id}:${job.generation}`,
            "system",
            `Background ${job.kind} failed. Retry it from Activity. (${error})`,
            job.id,
          );
        yield* event("jobs", now);
      }),
    );
  });
  const tick = Effect.fn("BotStore.tick")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const r of yield* list("responsibility", BotResponsibility, 1000)) {
          if (r.state !== "active" || r.nextAt === null || r.nextAt > now) continue;
          const active = (yield* list("task", BotTask, 1000)).some(
            (t) => t.responsibilityId === r.id && !terminal.has(t.status),
          );
          const queued =
            yield* sql`SELECT id FROM jobs WHERE state IN ('pending','running') AND kind IN ('turn','responsibility','task_wake') AND json_extract(data,'$.responsibilityId')=${r.id} LIMIT 1`;
          if (active || queued.length) continue;
          yield* enqueue(
            `occurrence:${r.id}:${r.revision}:${r.nextAt}`,
            "responsibility",
            { text: "", responsibilityId: r.id, revision: r.revision },
            now,
            r.id,
          );
          yield* write("responsibility", r.id, r.revision, {
            ...r,
            nextAt: nextWake(r.schedule, now),
            updatedAt: now,
          });
          yield* event("responsibilities", now);
        }
        for (const task of yield* list("task", BotTask, 1000)) {
          if (terminal.has(task.status)) continue;
          const env = yield* sql<{
            last_seen: number;
          }>`SELECT last_seen FROM environments WHERE id=${task.environmentId}`;
          if (
            (env[0]?.last_seen ?? 0) < now - 30000 &&
            task.status !== "waiting_environment" &&
            task.status !== "cancellation_requested"
          ) {
            const offline = {
              ...task,
              status: "waiting_environment" as const,
              updatedAt: now,
            };
            yield* write("task", task.id, 0, offline);
            yield* taskProgress(offline, task);
            yield* event("tasks", now);
          }
          const watch = yield* taskWatch(task);
          if (
            task.status !== "cancellation_requested" &&
            watch.nextAt !== null &&
            watch.nextAt <= now &&
            (env[0]?.last_seen ?? 0) >= now - 30000
          ) {
            const active =
              yield* sql`SELECT id FROM jobs WHERE kind='task_wake' AND state IN ('pending','running') AND json_extract(data,'$.wake.taskId')=${task.id} LIMIT 1`;
            if (!active.length) {
              const intervalMs = Math.max(
                watch.intervalMs,
                Math.min(3600000, watch.intervalMs * 2),
              );
              yield* wakeTask(
                task,
                { ...watch, intervalMs, nextAt: now + intervalMs },
                "stalled",
                now,
              );
            }
          }
          const pending = yield* sql<{
            id: string;
          }>`SELECT id FROM bridge_commands WHERE task_id=${task.id} AND state='pending' LIMIT 1`;
          if (pending.length === 0)
            yield* queueBridge(task, `${task.id}:inspect:${Math.floor(now / 5000)}`, "inspect", "");
        }
      }),
    );
  });
  const authorized = Effect.fn("BotStore.authorized")(function* (id: string, hash: string) {
    const envs = yield* sql<{
      identity: string | null;
      last_seen: number;
      projects: string;
      providers: string;
    }>`SELECT identity,last_seen,projects,providers FROM environments WHERE id=${id} AND token_hash=${hash} AND revoked=0`;
    if (!envs[0]) return yield* new BotError({ category: "unauthorized" });
    return envs[0];
  });
  const poll = Effect.fn("BotStore.poll")(function* (
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
        const providers = serialize(input.providers ?? []);
        yield* sql`UPDATE environments SET identity=${input.identity},last_seen=${now},projects=${serialize(input.projects)},providers=${providers} WHERE id=${id}`;
        const reconnect = env.identity === null || env.last_seen < now - 30000;
        if (
          !reconnect &&
          (env.projects !== serialize(input.projects) || env.providers !== providers)
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
          data: string;
        }>`UPDATE bridge_commands SET last_delivery=${now} WHERE id IN (SELECT id FROM bridge_commands WHERE environment_id=${id} AND state='pending' AND last_delivery < ${now - 10000} ORDER BY rowid LIMIT 4) RETURNING data`;
        return {
          commands: yield* Effect.forEach(rows, (row) => decodeBridgeCommand(row.data)),
        };
      }),
    );
  });
  const report = Effect.fn("BotStore.report")(function* (
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
  const protect = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(storageError));
  const recover = sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* deliveries.recover;
      yield* sql`UPDATE jobs SET state='pending',generation=generation+1,lease_until=NULL,due_at=MIN(due_at,${now}) WHERE state='running'`;
      yield* sql`UPDATE bridge_commands SET last_delivery=0 WHERE state='pending'`;
    }),
  );
  return Store.of({
    recover: protect(recover),
    command: (c, h, o, source) => protect(command(c, h, o, source)),
    snapshot: (before, after) => protect(snapshot(before, after)),
    changed: (after) => protect(changed(after)),
    search: (query) => protect(search(query)),
    claim: () => protect(claim()),
    finish: (job, error) => protect(finish(job, error)),
    tick: () => protect(tick()),
    isTaskWakeCurrent: (wake) => protect(isTaskWakeCurrent(wake)),
    poll: (id, hash, input) => protect(poll(id, hash, input)),
    report: (id, hash, input) => protect(report(id, hash, input)),
    settings: protect(settings),
    append: (id, role, text, source) => protect(append(id, role, text, source)),
  });
});

export const layer = Layer.effect(Store, make).pipe(Layer.provideMerge(DeliveryStore.layer));
