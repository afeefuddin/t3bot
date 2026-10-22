import { responsibilityPrompt } from "./prompts.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotError, isBotError } from "./config.ts";
import { BotTask, BotResponsibility } from "@t3tools/contracts/bot";
import { stableId } from "@t3tools/shared/stableId";
import { nextWake } from "./schedule.ts";
import * as Records from "./Records.ts";
import * as Tasks from "./Tasks.ts";
import * as Goals from "./Goals.ts";
import * as DeliveryStore from "./DeliveryStore.ts";
const terminal = new Set(["completed", "failed", "cancelled"]);
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
export type JobLane = "coordinator" | "background";
const decodeAgentJob = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ agentId: Schema.String })),
);

export class Jobs extends Context.Service<
  Jobs,
  {
    readonly claim: (lane?: JobLane) => Effect.Effect<JobRow | null, BotError>;
    readonly finish: (
      job: JobRow,
      error?: string,
    ) => Effect.Effect<JobRow["state"] | null, BotError>;
    readonly tick: () => Effect.Effect<void, BotError>;
    readonly recover: Effect.Effect<void, BotError>;
    readonly fireResponsibility: (
      r: BotResponsibility,
      occurrence: string,
      now: number,
    ) => Effect.Effect<void, BotError>;
  }
>()("@t3tools/bot/Jobs") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { list, write, event, enqueue, append } = yield* Records.Records;
  const deliveries = yield* DeliveryStore.DeliveryStore;
  const goals = yield* Goals.Goals;
  const tasks = yield* Tasks.Tasks;
  const fireResponsibility = Effect.fn("BotJobs.fireResponsibility")(function* (
    r: BotResponsibility,
    occurrence: string,
    now: number,
  ) {
    yield* enqueue(
      stableId("responsibility-run", r.id, r.revision, occurrence),
      "turn",
      {
        text: responsibilityPrompt(r),
        responsibilityId: r.id,
        revision: r.revision,
      },
      now,
      r.id,
    );
  });
  const claim = Effect.fn("BotJobs.claim")(function* (lane: JobLane = "coordinator") {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows =
          yield* sql<JobRow>`UPDATE jobs SET state='running',attempts=attempts+1,generation=generation+1,lease_until=${now + 180000} WHERE id=(SELECT id FROM jobs WHERE ((state='pending' AND due_at<=${now}) OR (state='running' AND lease_until<${now})) AND (CASE WHEN ${lane}='background' THEN kind IN ('agent','summary','memory_review') ELSE kind NOT IN ('agent','summary','memory_review') END) AND (SELECT COUNT(*) FROM jobs active WHERE active.state='running' AND active.lease_until>=${now} AND (CASE WHEN ${lane}='background' THEN active.kind IN ('agent','summary','memory_review') ELSE active.kind NOT IN ('agent','summary','memory_review') END)) < ${lane === "background" ? 2 : 1} ORDER BY CASE WHEN kind='turn' AND json_extract(data,'$.messageId') IS NOT NULL THEN 0 WHEN kind='turn' THEN 1 WHEN kind='responsibility' THEN 2 WHEN kind='agent' THEN 3 WHEN kind='memory_review' THEN 4 WHEN kind='summary' THEN 5 ELSE 3 END,due_at,id LIMIT 1) RETURNING *`;
        if (rows.length) yield* event("jobs", now);
        return rows[0] ?? null;
      }),
    );
  });
  const finish = Effect.fn("BotJobs.finish")(function* (job: JobRow, error?: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = error
          ? ["budget", "invalid", "unauthorized", "conflict"].includes(error) || job.attempts >= 4
            ? "failed"
            : "pending"
          : "done";
        const rows = yield* sql<{
          id: string;
        }>`UPDATE jobs SET state=${state},error=${error ?? null},lease_until=NULL,due_at=${now + Math.min(60000, 2000 * 2 ** job.attempts)} WHERE id=${job.id} AND generation=${job.generation} AND state='running' RETURNING id`;
        if (!rows.length) return null;
        if (state === "failed" && job.kind === "agent") {
          const { agentId } = yield* decodeAgentJob(job.data);
          yield* enqueue(
            `agent-failure:${job.id}:${job.generation}`,
            "agent_wake",
            {
              agentId,
              text: `Internal worker ${agentId} failed (${error}). Inspect its persisted status and any process receipts before deciding whether to retry or report the blocker. A failed worker has not completed its task.`,
            },
            now,
            job.id,
          );
        } else if (state === "failed")
          yield* append(
            `failure:${job.id}:${job.generation}`,
            "system",
            `Background ${job.kind} failed. Retry it from Activity. (${error})`,
            job.id,
          );
        yield* event("jobs", now);
        return state;
      }),
    );
  });
  const tick = Effect.fn("BotJobs.tick")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* goals.tick;
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
        yield* tasks.tick;
      }),
    );
  });
  const recover = sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* deliveries.recover;
      yield* sql`UPDATE jobs SET state='pending',generation=generation+1,lease_until=NULL,due_at=MIN(due_at,${now}) WHERE state='running'`;
      yield* sql`UPDATE bridge_commands SET last_delivery=0 WHERE state='pending'`;
    }),
  );
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotError(cause) ? cause : new BotError({ category: "storage", cause }),
      ),
    );
  return Jobs.of({
    claim: (lane) => protect(claim(lane)),
    finish: (job, error) => protect(finish(job, error)),
    tick: () => protect(tick()),
    recover: protect(recover),
    fireResponsibility: (r, occurrence, now) => protect(fireResponsibility(r, occurrence, now)),
  });
});
export const layer = Layer.effect(Jobs, make);
