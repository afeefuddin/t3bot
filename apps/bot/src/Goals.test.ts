import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { BotCommand, BotGoal, BotVerificationCheck } from "@t3tools/contracts/bot";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { BotConfig } from "./config.ts";
import * as Database from "./database.ts";
import * as Store from "./Store.ts";
import { toolRunner } from "./tools.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const config = Layer.succeed(BotConfig, {
  provider: "test",
  providers: [{ id: "test", endpoint: "http://localhost", model: "test", apiKey: "" }],
});
const layer = (filename = ":memory:") =>
  Store.layer.pipe(Layer.provideMerge(Database.layer(filename)), Layer.provide(config));
const goalInput = {
  type: "goal.create",
  requestId: "create",
  id: "fix-bug",
  title: "Fix the bug",
  objective: "Correct the calculation in the selected project",
  criteria: ["Regression test passes", "Existing tests still pass"],
  environmentId: "env",
  projectId: "project",
} as const;
const poll = {
  protocol: 1,
  identity: "machine",
  projects: [{ id: "project", title: "Workspace", instanceId: "worker", model: "test" }],
} as const;
const setup = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* store.command({ type: "environment.create", requestId: "env", name: "Machine" }, "hash");
  yield* store.poll("env", "hash", poll);
  yield* store.command(goalInput);
  yield* store.command({
    type: "task.start",
    requestId: "work",
    goalId: goalInput.id,
    title: "Repair",
    instructions: "Fix and test",
    environmentId: "env",
    projectId: "project",
    isolated: true,
  });
});
const finishWork = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* TestClock.adjust("11 seconds");
  const command = (yield* store.poll("env", "hash", poll)).commands[0];
  assert.ok(command);
  yield* store.report("env", "hash", {
    commandId: command.id,
    taskId: command.taskId,
    threadId: command.threadId,
    runId: "work-run",
    status: "completed",
    result: "Implemented the fix. 2 tests passed.",
  });
});
const goal = Effect.gen(function* () {
  const store = yield* Store.Store;
  const result = (yield* store.snapshot()).goals?.[0];
  assert.ok(result);
  return result;
});
const verification =
  "PASS 1: node --test regression.test.mjs: 1 passed, 0 failed.\nPASS 2: node --test: 2 passed, 0 failed.";
const checks: ReadonlyArray<BotVerificationCheck> = [
  {
    id: "verify-check",
    runId: "verify-run",
    command: "node --test",
    output: "2 tests passed",
    exitCode: 0,
    outcome: "passed",
  },
];
const complete = (current: BotGoal): BotCommand => ({
  type: "goal.complete",
  requestId: "complete",
  id: current.id,
  revision: current.revision,
  summary: "Fixed and checked",
  evidence: current.criteria.map((_criterion, index) => ({
    criterion: index,
    taskId: "work",
    generation: 1,
    runId: "verify-run",
    quote: verification.split("\n")[index]!,
    checkIds: ["verify-check"],
  })),
});

it.effect("requires a separate verification turn with passing evidence for every criterion", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* setup;
    yield* finishWork;
    assert.equal((yield* goal).state, "active");
    assert.equal((yield* store.command(complete(yield* goal)).pipe(Effect.result))._tag, "Failure");
    yield* store.command({
      type: "goal.verify",
      requestId: "verify",
      id: goalInput.id,
      revision: (yield* goal).revision,
      taskId: "work",
    });
    const command = (yield* store.poll("env", "hash", poll)).commands[0];
    assert.ok(command);
    assert.equal(command.kind, "followup");
    assert.equal(command.threadId, "work");
    assert.include(command.text, "Do not change code");
    assert.equal((yield* goal).state, "verifying");
    assert.equal((yield* store.command(complete(yield* goal)).pipe(Effect.result))._tag, "Failure");
    yield* store.report("env", "hash", {
      commandId: command.id,
      taskId: "work",
      threadId: "work",
      runId: "verify-run",
      status: "completed",
      result: verification,
      checks,
    });
    const proof = complete(yield* goal);
    assert.equal(proof.type, "goal.complete");
    if (proof.type !== "goal.complete") return;
    for (const evidence of [
      proof.evidence.slice(0, 1),
      proof.evidence.map((e) => ({ ...e, checkIds: [] })),
      proof.evidence.map((e) => ({ ...e, checkIds: ["fabricated"] })),
      proof.evidence.map((e) => ({ ...e, checkIds: ["verify-check", "verify-check"] })),
      proof.evidence.map((e) => ({ ...e, generation: 0 })),
      proof.evidence.map((e) => ({ ...e, quote: "PASS 1: invented" })),
    ]) {
      assert.equal(
        (yield* store.command({ ...proof, evidence }).pipe(Effect.result))._tag,
        "Failure",
      );
    }
    yield* store.command(proof);
    yield* store.command(proof);
    assert.equal((yield* goal).state, "completed");
    assert.equal(
      (yield* store.snapshot()).messages.filter((m) => m.text.startsWith("Goal completed:")).length,
      1,
    );
    const current = yield* goal;
    yield* store.command({
      type: "goal.state",
      requestId: "reopen",
      id: current.id,
      revision: current.revision,
      state: "active",
      reason: "Recheck after a change",
    });
    assert.deepEqual((yield* goal).evidence, []);
  }).pipe(Effect.provide(layer())),
);

it.effect("pausing fences stale reviews and holds queued verification until resumed", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* setup;
    yield* finishWork;
    const before = yield* goal;
    yield* store.command({
      type: "goal.verify",
      requestId: "verify",
      id: before.id,
      revision: before.revision,
      taskId: "work",
    });
    yield* store.command({
      type: "goal.state",
      requestId: "pause",
      id: before.id,
      revision: (yield* goal).revision,
      state: "paused",
      reason: "Owner paused work",
    });
    assert.equal(
      yield* store.isGoalWakeCurrent({ goalId: before.id, generation: before.generation }),
      false,
    );
    assert.equal((yield* store.poll("env", "hash", poll)).commands.length, 0);
    const paused = yield* goal;
    yield* store.command({
      type: "goal.state",
      requestId: "resume",
      id: paused.id,
      revision: paused.revision,
      state: "active",
      reason: "Continue",
    });
    assert.equal((yield* store.poll("env", "hash", poll)).commands[0]?.kind, "followup");
  }).pipe(Effect.provide(layer())),
);

it.effect("rejects project scope expansion and unauthorized thread context", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* setup;
    assert.equal(
      (yield* store
        .command({ ...goalInput, requestId: "outside", id: "outside", projectId: "other" })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(
      (yield* store
        .poll("env", "hash", {
          ...poll,
          threads: [
            {
              id: "secret",
              projectId: "other",
              title: "Private",
              status: "idle",
              updatedAt: 0,
              excerpt: "Not authorized",
              modelSelection: { instanceId: ProviderInstanceId.make("worker"), model: "test" },
            },
          ],
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(
      (yield* store
        .command(
          {
            type: "task.start",
            requestId: "unrelated",
            title: "Other work",
            instructions: "Do this",
            environmentId: "env",
            projectId: "project",
            isolated: false,
          },
          undefined,
          undefined,
          undefined,
          { goalId: goalInput.id, generation: 0 },
        )
        .pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("restores a queued verification after closing and reopening the actual database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-goal-restart-" });
    const filename = `${home}/bot.sqlite`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store.Store;
        yield* setup;
        yield* finishWork;
        yield* store.command({
          type: "goal.verify",
          requestId: "verify",
          id: goalInput.id,
          revision: (yield* goal).revision,
          taskId: "work",
        });
        const sent = (yield* store.poll("env", "hash", poll)).commands[0];
        assert.ok(sent);
      }).pipe(Effect.provide(layer(filename))),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store.Store;
        yield* store.recover;
        const resumed = (yield* store.poll("env", "hash", poll)).commands[0];
        assert.ok(resumed);
        assert.equal(resumed.kind, "followup");
        assert.equal(resumed.threadId, "work");
        assert.deepEqual((yield* goal).criteria, goalInput.criteria);
        yield* store.report("env", "hash", {
          commandId: resumed.id,
          taskId: "work",
          threadId: "work",
          runId: "verify-run",
          status: "completed",
          result: verification,
          checks,
        });
        yield* store.command(complete(yield* goal));
        assert.equal((yield* goal).state, "completed");
        assert.equal((yield* store.snapshot()).tasks.length, 1);
      }).pipe(Effect.provide(layer(filename))),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const decodeInspection = Schema.decodeUnknownEffect(
  Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        result: Schema.String,
        nextOffset: Schema.NullOr(Schema.Number),
      }),
    ),
  }),
);
it.effect("lets the coordinator retrieve verification evidence beyond the first result page", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* setup;
    yield* TestClock.adjust("11 seconds");
    const command = (yield* store.poll("env", "hash", poll)).commands[0];
    assert.ok(command);
    const result = "context ".repeat(1500) + "PASS 1: regression command exited 0.";
    yield* store.report("env", "hash", {
      commandId: command.id,
      taskId: command.taskId,
      threadId: command.threadId,
      runId: "long-result",
      status: "completed",
      result,
    });
    yield* store.tick();
    const job = yield* store.claim();
    assert.ok(job);
    const invoke = yield* toolRunner;
    let offset = 0;
    let recovered = "";
    while (true) {
      const page = yield* decodeInspection(
        yield* invoke(
          {
            id: "inspect",
            type: "function",
            function: {
              name: "inspect_goal",
              arguments: JSON.stringify({ id: goalInput.id, taskId: command.taskId, offset }),
            },
          },
          {
            job,
            requestId: "inspect",
            messageId: undefined,
            responsibilityId: undefined,
            goalId: goalInput.id,
            commit: (input) => store.command(input),
          },
        ),
      );
      const worker = page.tasks.find((t) => t.id === command.taskId);
      assert.ok(worker);
      recovered += worker.result;
      if (worker.nextOffset === null) break;
      offset = worker.nextOffset;
    }
    assert.equal(recovered, result);
    assert.include(recovered, "PASS 1: regression command exited 0.");
  }).pipe(Effect.provide(layer())),
);

it.effect.each([
  ["assistant claims without executor receipts", [], verification],
  ["failed commands", [{ ...checks[0]!, outcome: "failed", exitCode: 1 }], verification],
  ["unknown exit codes", [{ ...checks[0]!, outcome: "unknown", exitCode: null }], verification],
  ["contradictory exit codes", [{ ...checks[0]!, outcome: "passed", exitCode: 1 }], verification],
  ["contradictory criterion results", checks, verification + "\nFAIL 1: regression still fails"],
  ["passing text embedded inside another statement", checks, "Did not verify: " + verification],
] as const)("rejects verification based on %s", ([_name, receipts, result]) =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* setup;
    yield* finishWork;
    yield* store.command({
      type: "goal.verify",
      requestId: "verify",
      id: goalInput.id,
      revision: (yield* goal).revision,
      taskId: "work",
    });
    const command = (yield* store.poll("env", "hash", poll)).commands[0]!;
    yield* store.report("env", "hash", {
      commandId: command.id,
      taskId: "work",
      threadId: "work",
      runId: "verify-run",
      status: "completed",
      result,
      checks: receipts,
    });
    assert.equal((yield* store.command(complete(yield* goal)).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* goal).state, "verifying");
  }).pipe(Effect.provide(layer())),
);

it.effect("rejects receipts from another run and clears them before a followup", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* setup;
    yield* finishWork;
    yield* store.command({
      type: "goal.verify",
      requestId: "verify",
      id: goalInput.id,
      revision: (yield* goal).revision,
      taskId: "work",
    });
    const command = (yield* store.poll("env", "hash", poll)).commands[0]!;
    const report = {
      commandId: command.id,
      taskId: "work",
      threadId: "work",
      runId: "verify-run",
      status: "completed" as const,
      result: verification,
    };
    assert.equal(
      (yield* store
        .report("env", "hash", { ...report, checks: [{ ...checks[0]!, runId: "other-run" }] })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    yield* store.report("env", "hash", { ...report, checks });
    assert.equal((yield* store.goalContext(goalInput.id)).tasks[0]?.checks?.length, 1);
    yield* store.command({
      type: "task.followup",
      requestId: "repair",
      id: "work",
      text: "Repair another case",
    });
    assert.deepEqual((yield* store.goalContext(goalInput.id)).tasks[0]?.checks, []);
  }).pipe(Effect.provide(layer())),
);

it.effect.each(["task.start", "task.followup", "goal.verify"] as const)(
  "blocks exhausted goals atomically before %s and resumes with an explicit new budget",
  (dispatch) =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      yield* setup;
      yield* finishWork;
      yield* sql`UPDATE records SET data=json_set(data,'$.rounds',24) WHERE kind='goal'`;
      const before = yield* goal;
      const command: BotCommand =
        dispatch === "task.start"
          ? {
              type: dispatch,
              requestId: "exhausted",
              goalId: before.id,
              title: "More",
              instructions: "Keep working",
              environmentId: "env",
              projectId: "project",
              isolated: true,
            }
          : dispatch === "task.followup"
            ? { type: dispatch, requestId: "exhausted", id: "work", text: "Keep working" }
            : {
                type: dispatch,
                requestId: "exhausted",
                id: before.id,
                revision: before.revision,
                taskId: "work",
              };
      yield* store.command(command);
      yield* store.command(command);
      yield* store.recover;
      const blocked = yield* goal;
      assert.equal(blocked.state, "blocked");
      assert.equal(blocked.rounds, 24);
      assert.equal(blocked.nextAt, null);
      assert.include(blocked.reason, "budget exhausted");
      assert.equal(
        yield* store.isGoalWakeCurrent({ goalId: before.id, generation: before.generation }),
        false,
      );
      assert.equal((yield* store.poll("env", "hash", poll)).commands.length, 0);
      assert.equal((yield* store.snapshot()).tasks.length, 1);
      assert.equal((yield* store.snapshot()).tasks[0]?.generation, 0);
      assert.equal(
        (yield* store.snapshot()).messages.filter((m) => m.text.includes("budget exhausted"))
          .length,
        1,
      );
      yield* store.command({
        type: "goal.state",
        requestId: "resume-budget",
        id: blocked.id,
        revision: blocked.revision,
        state: "active",
        reason: "Owner authorizes another budget",
      });
      assert.equal((yield* goal).roundLimit, 48);
      yield* store.command({
        type: "task.followup",
        requestId: "resume-work",
        id: "work",
        text: "Continue with the approved budget",
      });
      assert.equal((yield* goal).rounds, 25);
      assert.equal((yield* store.poll("env", "hash", poll)).commands[0]?.kind, "followup");
    }).pipe(Effect.provide(layer())),
);

it.effect("allows the last authorized verification turn to complete the goal", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    yield* setup;
    yield* finishWork;
    yield* sql`UPDATE records SET data=json_set(data,'$.rounds',23) WHERE kind='goal'`;
    yield* store.command({
      type: "goal.verify",
      requestId: "last-verify",
      id: goalInput.id,
      revision: (yield* goal).revision,
      taskId: "work",
    });
    assert.equal((yield* goal).rounds, 24);
    const command = (yield* store.poll("env", "hash", poll)).commands[0]!;
    yield* store.report("env", "hash", {
      commandId: command.id,
      taskId: "work",
      threadId: "work",
      runId: "verify-run",
      status: "completed",
      result: verification,
      checks,
    });
    yield* store.command(complete(yield* goal));
    assert.equal((yield* goal).state, "completed");
  }).pipe(Effect.provide(layer())),
);

const decodeCheckPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    checks: Schema.Array(Schema.Struct({ id: Schema.String, output: Schema.String })),
    nextOffset: Schema.NullOr(Schema.Number),
  }),
);
it.effect("pages persisted executor receipts without inflating regular client snapshots", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* setup;
    yield* TestClock.adjust("11 seconds");
    const command = (yield* store.poll("env", "hash", poll)).commands[0]!;
    const receipts = Array.from({ length: 12 }, (_, index) => ({
      ...checks[0]!,
      id: `receipt-${index}`,
      command: "x".repeat(2048),
      output: `${index}:` + "y".repeat(1496),
    }));
    yield* store.report("env", "hash", {
      commandId: command.id,
      taskId: command.taskId,
      threadId: command.threadId,
      runId: "verify-run",
      status: "completed",
      result: "Executed checks",
      checks: receipts,
    });
    assert.equal((yield* store.snapshot()).tasks[0]?.checks, undefined);
    yield* store.tick();
    const job = (yield* store.claim())!;
    const invoke = yield* toolRunner;
    let offset = 0;
    const recovered: Array<{ readonly id: string; readonly output: string }> = [];
    while (true) {
      const response = yield* invoke(
        {
          id: "checks",
          type: "function",
          function: {
            name: "inspect_goal_checks",
            arguments: JSON.stringify({ id: goalInput.id, taskId: command.taskId, offset }),
          },
        },
        {
          job,
          requestId: "checks",
          messageId: undefined,
          responsibilityId: undefined,
          goalId: goalInput.id,
          commit: (input) => store.command(input),
        },
      );
      assert.ok(JSON.stringify(response).length < 30000);
      const page = yield* decodeCheckPage(response);
      recovered.push(...page.checks);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    assert.deepEqual(
      recovered,
      receipts.map(({ id, output }) => ({ id, output })),
    );
  }).pipe(Effect.provide(layer())),
);
