import { taskWakePrompt, workerMemoryContext, workerGoalContext } from "./prompts.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotError, isBotError } from "./config.ts";
import { serialize } from "./json.ts";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import {
  BotTask,
  type BotGoal,
  BotMemory,
  BotEnvironment,
  BotWorkerProvider,
  BotThreadContext,
  BotBridgeCommand,
  type BotCommand,
} from "@t3tools/contracts/bot";
import { stableId } from "@t3tools/shared/stableId";
import { isBotWorkerSelectionAvailable } from "@t3tools/shared/botWorkers";
import { TaskWake, TaskWatch, DEFAULT_TASK_CHECK_MS } from "./taskWake.ts";
import * as Records from "./Records.ts";
import * as Goals from "./Goals.ts";
import * as DeliveryStore from "./DeliveryStore.ts";
const terminal = new Set<BotTask["status"]>(["completed", "failed", "cancelled"]);
const decodeProjects = Schema.decodeEffect(Schema.fromJsonString(BotEnvironment.fields.projects));
const decodeProviders = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(BotWorkerProvider)));
const decodeThreads = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(BotThreadContext)));

export class Tasks extends Context.Service<
  Tasks,
  {
    readonly get: (id: string) => Effect.Effect<BotTask, BotError>;
    readonly progress: (task: BotTask, previous?: BotTask) => Effect.Effect<void, BotError>;
    readonly isWakeCurrent: (wake: TaskWake) => Effect.Effect<boolean, BotError>;
    readonly start: (
      id: string,
      input: Omit<Extract<BotCommand, { type: "task.start" }>, "type" | "requestId">,
      responsibilityId?: string | null,
      responsibilityRevision?: number | null,
      replySourceId?: string,
    ) => Effect.Effect<BotTask | BotGoal, BotError>;
    readonly followup: (
      id: string,
      requestId: string,
      text: string,
      purpose: "work" | "verification",
      replySourceId?: string,
    ) => Effect.Effect<BotGoal | void, BotError>;
    readonly watch: (
      id: string,
      afterMs: number | null,
    ) => Effect.Effect<{ nextCheckAt: number | null }, BotError>;
    readonly cancel: (
      id: string,
      requestId: string,
      replySourceId?: string,
    ) => Effect.Effect<void, BotError>;
    readonly tick: Effect.Effect<void, BotError>;
  }
>()("@t3tools/bot/Tasks") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { read, list, write, event, enqueue } = yield* Records.Records;
  const deliveries = yield* DeliveryStore.DeliveryStore;
  const goals = yield* Goals.Goals;
  const requireTask = (id: string) =>
    read("task", id, BotTask).pipe(
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
  const wakeTask = Effect.fn("BotTasks.wakeTask")(function* (
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
        text: taskWakePrompt(task, reason),
        taskId: task.id,
        ...(task.goalId
          ? {
              goalId: task.goalId,
              goalWake: {
                goalId: task.goalId,
                generation: (yield* goals.get(task.goalId)).generation,
              },
            }
          : {}),
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
  const taskProgress = Effect.fn("BotTasks.taskProgress")(function* (
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
  const isTaskWakeCurrent = Effect.fn("BotTasks.isTaskWakeCurrent")(function* (wake: TaskWake) {
    const task = yield* read("task", wake.taskId, BotTask);
    if (!task || task.generation !== wake.generation || task.status === "cancellation_requested")
      return false;
    const watch = yield* taskWatch(task);
    if (task.goalId && !["active", "verifying"].includes((yield* goals.get(task.goalId)).state))
      return false;
    return (
      watch.revision === wake.revision &&
      (wake.reason !== "stalled" || watch.enabled !== false) &&
      (!terminal.has(task.status) || task.status === wake.reason)
    );
  });
  const queueBridge = Effect.fn("BotTasks.queueBridge")(function* (
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
    const context = workerMemoryContext(memories);
    const goal = task.goalId ? yield* goals.get(task.goalId) : null;
    const goalContext = workerGoalContext(goal, task.purpose);
    const data: BotBridgeCommand = {
      id: commandId,
      taskId: task.id,
      generation: task.generation,
      ...(task.purpose ? { purpose: task.purpose } : {}),
      kind,
      ...(task.existingThread ? { existingThread: true } : {}),
      projectId: task.projectId,
      threadId: task.threadId ?? task.id,
      runId: task.runId,
      text: text + goalContext + context,
      title: task.title,
      isolated,
      ...(task.modelSelection ? { modelSelection: task.modelSelection } : {}),
      ...(task.interactionMode ? { interactionMode: task.interactionMode } : {}),
    };
    yield* sql`INSERT OR IGNORE INTO bridge_commands(id,environment_id,task_id,data) VALUES(${commandId},${task.environmentId},${task.id},${serialize(data)})`;
  });
  const startTask = Effect.fn("BotTasks.startTask")(function* (
    id: string,
    input: {
      title: string;
      instructions: string;
      environmentId: string;
      projectId: string;
      isolated: boolean;
      goalId?: string;
      threadId?: string;
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
    if (input.goalId) {
      const goal = yield* goals.reserveRound(input.goalId, input.environmentId, input.projectId);
      if (goal.state === "blocked") return goal;
    }
    if (input.threadId) {
      const known = yield* sql<{
        threads: string;
      }>`SELECT threads FROM environments WHERE id=${input.environmentId}`;
      const thread = (yield* decodeThreads(known[0]?.threads ?? "[]")).find(
        (t) => t.id === input.threadId && t.projectId === input.projectId,
      );
      if (!thread || (input.isolated && !thread.isolated))
        return yield* new BotError({ category: "invalid" });
    }
    const activeTasks = (yield* list("task", BotTask, 1000)).filter((t) => !terminal.has(t.status));
    if (
      input.threadId &&
      activeTasks.some(
        (t) => t.environmentId === input.environmentId && t.threadId === input.threadId,
      )
    )
      return yield* new BotError({ category: "conflict" });
    if (activeTasks.length >= 16) return yield* new BotError({ category: "budget" });
    const task: BotTask = {
      id,
      ...input,
      modelSelection: selection,
      generation: 0,
      responsibilityId,
      responsibilityRevision,
      threadId: input.threadId ?? id,
      ...(input.threadId ? { existingThread: true } : {}),
      purpose: "work",
      runId: null,
      status: "queued",
      result: "",
      checks: [],
      updatedAt: now,
    };
    yield* write("task", id, 0, task);
    yield* write("task-watch", id, 0, yield* taskWatch(task));
    if (replySourceId ?? responsibilityId)
      yield* deliveries.inherit(id, (replySourceId ?? responsibilityId)!);
    yield* queueBridge(
      task,
      `${id}:start`,
      input.threadId ? "continue" : "start",
      input.instructions,
      input.isolated,
    );
    return task;
  });
  const followupTask = Effect.fn("BotTasks.followupTask")(function* (
    id: string,
    requestId: string,
    text: string,
    purpose: "work" | "verification",
    replySourceId?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const task = yield* requireTask(id);
    // Preserve the initial launch until its durable executor run is known.
    if (task.status === "cancellation_requested" || !task.runId)
      return yield* new BotError({ category: "conflict" });
    if (task.goalId) {
      const goal = yield* goals.reserveRound(
        task.goalId,
        task.environmentId,
        task.projectId,
        purpose,
      );
      if (goal.state === "blocked") return goal;
    }
    const next = {
      ...task,
      generation: task.generation + 1,
      purpose,
      result: "",
      checks: [],
      runId: task.runId,
      status: "queued" as const,
      updatedAt: now,
    };
    yield* sql`UPDATE bridge_commands SET state='done' WHERE task_id=${task.id} AND state='pending'`;
    yield* write("task", task.id, 0, next);
    yield* write("task-watch", task.id, 0, yield* taskWatch(next));
    if (replySourceId) yield* deliveries.inherit(task.id, replySourceId);
    yield* queueBridge(next, requestId, "followup", text);
  });
  const watch = Effect.fn("BotTasks.watch")(function* (id: string, afterMs: number | null) {
    const now = yield* Clock.currentTimeMillis;
    const task = yield* requireTask(id);
    if (terminal.has(task.status) || task.status === "cancellation_requested")
      return yield* new BotError({ category: "conflict" });
    const watch = yield* taskWatch(task);
    const next = {
      ...watch,
      enabled: afterMs !== null,
      nextAt: afterMs === null ? null : now + afterMs,
      intervalMs: afterMs ?? watch.intervalMs,
    };
    yield* write("task-watch", task.id, 0, next);
    return { nextCheckAt: next.nextAt };
  });
  const cancel = Effect.fn("BotTasks.cancel")(function* (
    id: string,
    requestId: string,
    replySourceId?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const task = yield* requireTask(id);
    if (terminal.has(task.status)) return;
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
      yield* queueBridge(next, `${requestId}:cancel`, "cancel", "Cancelled by owner");
  });
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
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
          const intervalMs = Math.max(watch.intervalMs, Math.min(3600000, watch.intervalMs * 2));
          yield* wakeTask(task, { ...watch, intervalMs, nextAt: now + intervalMs }, "stalled", now);
        }
      }
      const pending = yield* sql<{
        id: string;
      }>`SELECT id FROM bridge_commands WHERE task_id=${task.id} AND state='pending' LIMIT 1`;
      if (pending.length === 0)
        yield* queueBridge(task, `${task.id}:inspect:${Math.floor(now / 5000)}`, "inspect", "");
    }
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotError(cause) ? cause : new BotError({ category: "storage", cause }),
      ),
    );
  return Tasks.of({
    get: (id) => protect(requireTask(id)),
    progress: (task, previous) => protect(taskProgress(task, previous)),
    isWakeCurrent: (wake) => protect(isTaskWakeCurrent(wake)),
    start: (id, input, responsibility, revision, source) =>
      protect(startTask(id, input, responsibility, revision, source)),
    followup: (id, requestId, text, purpose, source) =>
      protect(followupTask(id, requestId, text, purpose, source)),
    watch: (id, afterMs) => protect(watch(id, afterMs)),
    cancel: (id, requestId, source) => protect(cancel(id, requestId, source)),
    tick: protect(tick),
  });
});
export const layer = Layer.effect(Tasks, make);
