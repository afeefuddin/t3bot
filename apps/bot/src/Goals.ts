import { goalReviewPrompt } from "./prompts.ts";
import { BotGoal, BotTask, type BotCommand } from "@t3tools/contracts/bot";
import { stableId } from "@t3tools/shared/stableId";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotError, isBotError } from "./config.ts";
import * as Records from "./Records.ts";
import * as DeliveryStore from "./DeliveryStore.ts";
import { serialize } from "./json.ts";

export const GoalWake = Schema.Struct({ goalId: Schema.String, generation: Schema.Number });
export type GoalWake = typeof GoalWake.Type;
type GoalCommand<K extends BotCommand["type"]> = Extract<BotCommand, { type: K }>;
const TURN_BUDGET = 24;
const running = new Set<BotGoal["state"]>(["active", "verifying"]);

export class Goals extends Context.Service<
  Goals,
  {
    readonly get: (id: string) => Effect.Effect<BotGoal, BotError>;
    readonly list: Effect.Effect<ReadonlyArray<BotGoal>, BotError>;
    readonly create: (
      input: GoalCommand<"goal.create">,
      source?: string,
    ) => Effect.Effect<BotGoal, BotError>;
    readonly setState: (input: GoalCommand<"goal.state">) => Effect.Effect<BotGoal, BotError>;
    readonly beginVerification: (
      input: GoalCommand<"goal.verify">,
    ) => Effect.Effect<BotGoal, BotError>;
    readonly complete: (input: GoalCommand<"goal.complete">) => Effect.Effect<BotGoal, BotError>;
    readonly reserveRound: (
      id: string,
      environmentId: string,
      projectId: string,
      purpose?: "work" | "verification",
    ) => Effect.Effect<BotGoal, BotError>;
    readonly isWakeCurrent: (wake: GoalWake) => Effect.Effect<boolean, BotError>;
    readonly tick: Effect.Effect<void, BotError>;
  }
>()("@t3tools/bot/Goals") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const deliveries = yield* DeliveryStore.DeliveryStore;
  const records = yield* Records.Records;
  const decodeGoal = Schema.decodeEffect(Schema.fromJsonString(BotGoal));
  const decodeTask = Schema.decodeEffect(Schema.fromJsonString(BotTask));
  const get = Effect.fn("BotGoals.get")(function* (id: string) {
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM records WHERE kind='goal' AND id=${id}`;
    if (!rows[0]) return yield* new BotError({ category: "not_found" });
    return yield* decodeGoal(rows[0].data);
  });
  const list = Effect.gen(function* () {
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM records WHERE kind='goal' ORDER BY json_extract(data,'$.updatedAt') DESC LIMIT 100`;
    return yield* Effect.forEach(rows, (row) => decodeGoal(row.data));
  });
  const write = Effect.fn("BotGoals.write")(function* (goal: BotGoal) {
    yield* sql`INSERT INTO records(kind,id,revision,data) VALUES('goal',${goal.id},${goal.revision},${serialize(goal)}) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data`;
    yield* sql`INSERT INTO events(kind,created_at) VALUES('goals',${goal.updatedAt})`;
    return goal;
  });
  const task = Effect.fn("BotGoals.task")(function* (id: string) {
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM records WHERE kind='task' AND id=${id}`;
    if (!rows[0]) return yield* new BotError({ category: "not_found" });
    return yield* decodeTask(rows[0].data);
  });
  const current = Effect.fn("BotGoals.current")(function* (id: string, revision: number) {
    const goal = yield* get(id);
    if (goal.revision !== revision) return yield* new BotError({ category: "conflict" });
    return goal;
  });
  const wake = Effect.fn("BotGoals.wake")(function* (goal: BotGoal, now: number) {
    const id = stableId("goal-review", goal.id, goal.generation, goal.nextAt ?? now);
    yield* sql`INSERT OR IGNORE INTO jobs(id,kind,data,due_at) VALUES(${id},'goal_wake',${serialize({ text: goalReviewPrompt(goal.id), goalWake: { goalId: goal.id, generation: goal.generation } })},${now})`;
    yield* deliveries.inherit(id, goal.id);
    yield* write({ ...goal, nextAt: now + 300000, updatedAt: now });
  });
  const create = Effect.fn("BotGoals.create")(function* (
    input: GoalCommand<"goal.create">,
    source?: string,
  ) {
    const existing = yield* sql`SELECT id FROM records WHERE kind='goal' AND id=${input.id}`;
    if (existing.length) return yield* new BotError({ category: "conflict" });
    if (
      new Set(input.criteria.map((c) => c.trim())).size !== input.criteria.length ||
      input.criteria.some((c) => !c.trim())
    )
      return yield* new BotError({ category: "invalid" });
    const count = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM records WHERE kind='goal' AND json_extract(data,'$.state') IN ('active','verifying','blocked','paused')`;
    if ((count[0]?.count ?? 0) >= 32) return yield* new BotError({ category: "budget" });
    const now = yield* Clock.currentTimeMillis;
    const goal: BotGoal = {
      id: input.id,
      revision: 1,
      generation: 0,
      title: input.title,
      objective: input.objective,
      criteria: input.criteria,
      environmentId: input.environmentId,
      projectId: input.projectId,
      state: "active",
      reason: "",
      evidence: [],
      rounds: 0,
      roundLimit: TURN_BUDGET,
      nextAt: now,
      updatedAt: now,
    };
    yield* write(goal);
    if (source) yield* deliveries.inherit(goal.id, source);
    return goal;
  });
  const setState = Effect.fn("BotGoals.setState")(function* (input: GoalCommand<"goal.state">) {
    const goal = yield* current(input.id, input.revision);
    const now = yield* Clock.currentTimeMillis;
    // Generation fences queued reviews and model responses when the owner pauses or reopens a goal.
    yield* sql`UPDATE jobs SET state='done' WHERE state='pending' AND kind='goal_wake' AND json_extract(data,'$.goalWake.goalId')=${goal.id}`;
    const updated = yield* write({
      ...goal,
      roundLimit:
        input.state === "active" &&
        !running.has(goal.state) &&
        goal.rounds >= (goal.roundLimit ?? TURN_BUDGET)
          ? goal.rounds + TURN_BUDGET
          : (goal.roundLimit ?? TURN_BUDGET),
      revision: goal.revision + 1,
      generation: goal.generation + 1,
      state: input.state,
      reason: input.reason,
      evidence: [],
      nextAt: input.state === "active" ? now : null,
      updatedAt: now,
    });
    if (input.state === "blocked")
      yield* records.append(
        `goal-blocked:${goal.id}:${updated.revision}`,
        "assistant",
        `Goal needs your input: ${goal.title}\n${input.reason}`,
        goal.id,
      );
    return updated;
  });
  const reserveRound = Effect.fn("BotGoals.reserveRound")(function* (
    id: string,
    environmentId: string,
    projectId: string,
    purpose: "work" | "verification" = "work",
  ) {
    const goal = yield* get(id);
    if (
      !running.has(goal.state) ||
      goal.environmentId !== environmentId ||
      goal.projectId !== projectId
    )
      return yield* new BotError({ category: "unauthorized" });
    // Returning the blocked goal commits exhaustion; a dispatch error would roll it back.
    if (goal.rounds >= (goal.roundLimit ?? TURN_BUDGET))
      return yield* setState({
        type: "goal.state",
        requestId: `goal-budget:${goal.id}:${goal.generation}`,
        id: goal.id,
        revision: goal.revision,
        state: "blocked",
        reason: `Worker turn budget exhausted (${goal.rounds}/${goal.roundLimit ?? TURN_BUDGET}). Review the progress and resume the goal to authorize another ${TURN_BUDGET} worker turns.`,
      });
    return yield* write({
      ...goal,
      rounds: goal.rounds + 1,
      state: purpose === "work" ? "active" : "verifying",
      evidence: [],
      updatedAt: yield* Clock.currentTimeMillis,
    });
  });
  const beginVerification = Effect.fn("BotGoals.beginVerification")(function* (
    input: GoalCommand<"goal.verify">,
  ) {
    const goal = yield* current(input.id, input.revision);
    const worker = yield* task(input.taskId);
    if (
      !running.has(goal.state) ||
      worker.goalId !== goal.id ||
      !["completed", "failed"].includes(worker.status) ||
      !worker.runId
    )
      return yield* new BotError({ category: "conflict" });
    return yield* write({
      ...goal,
      revision: goal.revision + 1,
      state: "verifying",
      evidence: [],
      updatedAt: yield* Clock.currentTimeMillis,
    });
  });
  const complete = Effect.fn("BotGoals.complete")(function* (input: GoalCommand<"goal.complete">) {
    const goal = yield* current(input.id, input.revision);
    if (
      goal.state !== "verifying" ||
      input.evidence.length !== goal.criteria.length ||
      new Set(input.evidence.map((e) => e.criterion)).size !== goal.criteria.length
    )
      return yield* new BotError({ category: "invalid" });
    const active =
      yield* sql`SELECT id FROM records WHERE kind='task' AND json_extract(data,'$.goalId')=${goal.id} AND json_extract(data,'$.status') NOT IN ('completed','failed','cancelled') LIMIT 1`;
    if (active.length) return yield* new BotError({ category: "conflict" });
    for (const evidence of input.evidence) {
      const worker = yield* task(evidence.taskId);
      if (
        !goal.criteria[evidence.criterion] ||
        worker.goalId !== goal.id ||
        worker.purpose !== "verification" ||
        worker.status !== "completed" ||
        worker.generation !== evidence.generation ||
        worker.runId !== evidence.runId ||
        !evidence.quote.startsWith(`PASS ${evidence.criterion + 1}:`) ||
        !worker.result.split("\n").some((line) => line.trim() === evidence.quote.trim()) ||
        worker.result
          .split("\n")
          .some((line) => line.trim().startsWith(`FAIL ${evidence.criterion + 1}:`)) ||
        !evidence.checkIds?.length ||
        new Set(evidence.checkIds).size !== evidence.checkIds.length ||
        evidence.checkIds.some((id) => {
          const check = worker.checks?.find((c) => c.id === id);
          return (
            !check ||
            check.runId !== evidence.runId ||
            check.outcome !== "passed" ||
            check.exitCode !== 0
          );
        })
      )
        return yield* new BotError({ category: "invalid" });
    }
    return yield* write({
      ...goal,
      revision: goal.revision + 1,
      generation: goal.generation + 1,
      state: "completed",
      reason: input.summary,
      evidence: input.evidence,
      nextAt: null,
      updatedAt: yield* Clock.currentTimeMillis,
    });
  });
  const isWakeCurrent = Effect.fn("BotGoals.isWakeCurrent")(function* (input: GoalWake) {
    const goal = yield* get(input.goalId);
    return running.has(goal.state) && goal.generation === input.generation;
  });
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const goal of yield* list) {
      if (!running.has(goal.state) || goal.nextAt === null || goal.nextAt > now) continue;
      const busy =
        yield* sql`SELECT id FROM records WHERE kind='task' AND json_extract(data,'$.goalId')=${goal.id} AND json_extract(data,'$.status') NOT IN ('completed','failed','cancelled') UNION ALL SELECT id FROM jobs WHERE state IN ('running','pending') AND (json_extract(data,'$.goalWake.goalId')=${goal.id} OR json_extract(data,'$.goalId')=${goal.id}) LIMIT 1`;
      if (!busy.length) yield* wake(goal, now);
    }
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotError(cause) ? cause : new BotError({ category: "storage", cause }),
      ),
    );
  return Goals.of({
    get: (id) => protect(get(id)),
    list: protect(list),
    create: (input, source) => protect(create(input, source)),
    setState: (input) => protect(setState(input)),
    beginVerification: (input) => protect(beginVerification(input)),
    complete: (input) => protect(complete(input)),
    reserveRound: (id, env, project, purpose) => protect(reserveRound(id, env, project, purpose)),
    isWakeCurrent: (input) => protect(isWakeCurrent(input)),
    tick: protect(tick),
  });
});

export const layer = Layer.effect(Goals, make);
