import { verificationPrompt } from "./prompts.ts";
import * as Records from "./Records.ts";
import * as Tasks from "./Tasks.ts";
import * as Jobs from "./Jobs.ts";
import * as BridgeStore from "./BridgeStore.ts";
import * as Goals from "./Goals.ts";
import * as DeliveryStore from "./DeliveryStore.ts";
import { TaskWake } from "./taskWake.ts";
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
  type BotGoal,
  BotWorkerProvider,
  BotThreadContext,
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
const decodeProjects = Schema.decodeEffect(Schema.fromJsonString(BotEnvironment.fields.projects));
const decodeProviders = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(BotWorkerProvider)));
const decodeThreads = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(BotThreadContext)));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
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
      goalScope?: Goals.GoalWake,
    ) => Effect.Effect<unknown, BotError>;
    readonly snapshot: (before?: number, after?: number) => Effect.Effect<BotSnapshot, BotError>;
    readonly goalContext: (
      id: string,
    ) => Effect.Effect<{ goal: BotGoal; tasks: ReadonlyArray<BotTask> }, BotError>;
    readonly changed: (after: number) => Effect.Effect<number, BotError>;
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<BotMessage>, BotError>;
    readonly claim: () => Effect.Effect<Jobs.JobRow | null, BotError>;
    readonly finish: (job: Jobs.JobRow, error?: string) => Effect.Effect<void, BotError>;
    readonly tick: () => Effect.Effect<void, BotError>;
    readonly isGoalWakeCurrent: (wake: Goals.GoalWake) => Effect.Effect<boolean, BotError>;
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
  const goals = yield* Goals.Goals;
  const { read, list, write, event, enqueue, append } = yield* Records.Records;
  const tasks = yield* Tasks.Tasks;
  const {
    get: requireTask,
    start: startTask,
    followup: followupTask,
    isWakeCurrent: isTaskWakeCurrent,
  } = tasks;
  const { claim, finish, tick, recover, fireResponsibility } = yield* Jobs.Jobs;
  const { poll, report } = yield* BridgeStore.BridgeStore;
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
  const requireResponsibility = (id: string) =>
    read("responsibility", id, BotResponsibility).pipe(
      Effect.flatMap((value) =>
        value ? Effect.succeed(value) : Effect.fail(new BotError({ category: "not_found" })),
      ),
    );
  const command = Effect.fn("BotStore.command")(function* (
    input: BotCommand,
    credentialHash?: string,
    origin?: { readonly responsibilityId: string; readonly revision: number },
    replySourceId?: string,
    goalScope?: Goals.GoalWake,
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
        if (goalScope) {
          if (!(yield* goals.isWakeCurrent(goalScope)))
            return yield* new BotError({ category: "conflict" });
          const allowed = [
            "task.start",
            "task.followup",
            "task.cancel",
            "task.watch",
            "goal.verify",
            "goal.complete",
            "goal.state",
            "memory.save",
          ];
          if (!allowed.includes(input.type))
            return yield* new BotError({ category: "unauthorized" });
          if (input.type === "task.start" && input.goalId !== goalScope.goalId)
            return yield* new BotError({ category: "unauthorized" });
          if (
            ["goal.verify", "goal.complete", "goal.state"].includes(input.type) &&
            "id" in input &&
            input.id !== goalScope.goalId
          )
            return yield* new BotError({ category: "unauthorized" });
          if (
            input.type === "task.followup" ||
            input.type === "task.cancel" ||
            input.type === "task.watch"
          ) {
            if ((yield* requireTask(input.id)).goalId !== goalScope.goalId)
              return yield* new BotError({ category: "unauthorized" });
          }
          if (input.type === "memory.save") {
            const goal = yield* goals.get(goalScope.goalId);
            if (input.scope !== `project:${goal.environmentId}:${goal.projectId}`)
              return yield* new BotError({ category: "unauthorized" });
          }
        }
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
        if (input.type === "task.start" && input.goalId && responsible)
          return yield* new BotError({ category: "unauthorized" });
        let result: unknown = { ok: true };
        switch (input.type) {
          case "goal.create": {
            const env = yield* sql<{
              projects: string;
            }>`SELECT projects FROM environments WHERE id=${input.environmentId} AND revoked=0`;
            if (
              !env[0] ||
              !(yield* decodeProjects(env[0].projects)).some((p) => p.id === input.projectId)
            )
              return yield* new BotError({ category: "unauthorized" });
            result = yield* goals.create(input, replySourceId);
            break;
          }
          case "goal.state":
            result = yield* goals.setState(input);
            break;
          case "goal.verify": {
            const goal = yield* goals.beginVerification(input);
            const blocked = yield* followupTask(
              input.taskId,
              input.requestId,
              verificationPrompt(goal.id),
              "verification",
              replySourceId,
            );
            result = blocked ?? goal;
            break;
          }
          case "goal.complete": {
            const goal = yield* goals.complete(input);
            const links = yield* Effect.forEach(
              [...new Set(goal.evidence.map((e) => e.taskId))],
              (id) => requireTask(id),
            );
            yield* append(
              `goal-complete:${goal.id}:${goal.revision}`,
              "assistant",
              `Goal completed: ${goal.title}\n${goal.reason}\n\n${goal.evidence.map((e) => `${e.criterion + 1}. ${goal.criteria[e.criterion]}\n${e.quote}`).join("\n\n")}\n\n${links.map((t) => `[${t.title}](t3-thread://v1/${t.threadId})`).join("\n")}`,
              goal.id,
            );
            result = goal;
            break;
          }
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
            result =
              (yield* followupTask(input.id, input.requestId, input.text, "work", replySourceId)) ??
              result;
            break;
          }
          case "task.watch":
            result = yield* tasks.watch(input.id, input.afterMs);
            break;
          case "task.cancel":
            yield* tasks.cancel(input.id, input.requestId, replySourceId);
            break;
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
      threads: string;
    }>`SELECT id,name,identity,revoked,last_seen AS lastSeen,projects,providers,threads FROM environments ORDER BY rowid LIMIT 50`;
    const environments = yield* Effect.forEach(envs, (env) =>
      Effect.gen(function* () {
        return {
          ...env,
          revoked: env.revoked === 1,
          projects: yield* decodeProjects(env.projects),
          threads: yield* decodeThreads(env.threads),
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
      goals: yield* goals.list,
      // Command receipts are inspected on demand rather than sent on every client poll.
      tasks: (yield* list("task", BotTask, 50)).map(({ checks: _checks, ...task }) => ({
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
  const goalContext = Effect.fn("BotStore.goalContext")(function* (id: string) {
    const goal = yield* goals.get(id);
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM records WHERE kind='task' AND json_extract(data,'$.goalId')=${id} ORDER BY json_extract(data,'$.updatedAt') DESC LIMIT 24`;
    const decode = Schema.decodeEffect(Schema.fromJsonString(BotTask));
    return { goal, tasks: yield* Effect.forEach(rows, (r) => decode(r.data)) };
  });
  const changed = Effect.fn("BotStore.changed")(function* (_after: number) {
    const rows = yield* sql<{ seq: number }>`SELECT COALESCE(MAX(seq),0) AS seq FROM events`;
    return rows[0]?.seq ?? 0;
  });
  const search = Effect.fn("BotStore.search")(function* (query: string) {
    const escaped = `"${query.slice(0, 200).replaceAll('"', '""')}"`;
    return yield* sql<BotMessage>`SELECT m.seq,m.id,m.role,m.text,m.created_at AS createdAt FROM history_search s JOIN messages m ON m.seq=s.rowid WHERE history_search MATCH ${escaped} ORDER BY rank LIMIT 12`;
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(storageError));
  return Store.of({
    recover: protect(recover),
    command: (c, h, o, source, goal) => protect(command(c, h, o, source, goal)),
    snapshot: (before, after) => protect(snapshot(before, after)),
    goalContext: (id) => protect(goalContext(id)),
    changed: (after) => protect(changed(after)),
    search: (query) => protect(search(query)),
    claim: () => protect(claim()),
    finish: (job, error) => protect(finish(job, error)),
    tick: () => protect(tick()),
    isGoalWakeCurrent: (wake) => goals.isWakeCurrent(wake),
    isTaskWakeCurrent: (wake) => protect(isTaskWakeCurrent(wake)),
    poll: (id, hash, input) => protect(poll(id, hash, input)),
    report: (id, hash, input) => protect(report(id, hash, input)),
    settings: protect(settings),
    append: (id, role, text, source) => protect(append(id, role, text, source)),
  });
});

const taskLayer = Tasks.layer.pipe(Layer.provideMerge(Goals.layer));
const domainLayer = Layer.mergeAll(Jobs.layer, BridgeStore.layer).pipe(
  Layer.provideMerge(taskLayer),
);
export const layer = Layer.effect(Store, make).pipe(
  Layer.provideMerge(domainLayer),
  Layer.provideMerge(Records.layer),
  Layer.provideMerge(DeliveryStore.layer),
);
