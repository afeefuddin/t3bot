import { assert, it } from "@effect/vitest";
import { BotBridgePoll, type BotBridgeReport, type BotChatMessage } from "@t3tools/contracts/bot";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { BotConfig } from "./config.ts";
import * as Store from "./Store.ts";
import * as Database from "./database.ts";
import * as Coordinator from "./Coordinator.ts";
import * as Model from "./Model.ts";
import { TaskWake } from "./taskWake.ts";

const poll = Schema.decodeUnknownSync(BotBridgePoll)({
  protocol: 1,
  identity: "machine",
  projects: [{ id: "project", title: "Any project" }],
  providers: [
    {
      instanceId: "worker",
      driver: "claudeAgent",
      name: "Configured worker",
      interactionModes: ["default", "plan"],
      models: [
        {
          id: "custom-model",
          name: "Custom model",
          options: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      ],
    },
  ],
});
const config = Layer.succeed(
  BotConfig,
  BotConfig.of({
    provider: "coordinator",
    providers: [{ id: "coordinator", endpoint: "http://model.invalid", model: "test", apiKey: "" }],
  }),
);
const storeLayer = Store.layer.pipe(
  Layer.provideMerge(Database.layer(":memory:")),
  Layer.provide(config),
);
const decodeWake = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ wake: TaskWake })),
);
const setup = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* store.command({ type: "environment.create", requestId: "env", name: "Machine" }, "hash");
  yield* store.poll("env", "hash", poll);
  yield* store.command({
    type: "task.start",
    requestId: "task",
    title: "Investigate",
    instructions: "Find and verify the answer",
    environmentId: "env",
    projectId: "project",
    isolated: false,
    modelSelection: {
      instanceId: poll.providers![0]!.instanceId,
      model: "custom-model",
      options: [{ id: "effort", value: "high" }],
    },
    interactionMode: "plan",
  });
});
const report = (status: BotBridgeReport["status"], result = "") =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    yield* TestClock.adjust("11 seconds");
    const commands = yield* store.poll("env", "hash", poll);
    const command = commands.commands[0];
    assert.ok(command);
    const input = {
      commandId: command.id,
      taskId: "task",
      threadId: "task",
      runId: "run",
      status,
      result,
    };
    yield* store.report("env", "hash", input);
    return input;
  });
const wakeDue = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* TestClock.adjust("5 minutes");
  yield* store.poll("env", "hash", poll);
  yield* store.tick();
});

it.effect(
  "lets a scheduled responsibility discover and select its worker without a user message",
  () => {
    let calls = 0;
    const model = Layer.succeed(
      Model.Model,
      Model.Model.of({
        complete: (_provider, messages) =>
          Effect.sync(() => {
            calls++;
            const decision =
              calls === 1
                ? {
                    name: "list_worker_models",
                    arguments: JSON.stringify({ environmentId: "env", instanceId: "worker" }),
                  }
                : calls === 2
                  ? {
                      name: "start_task",
                      arguments: JSON.stringify({
                        title: "Review",
                        instructions: "Inspect the project and verify the findings",
                        environmentId: "env",
                        projectId: "project",
                        isolated: true,
                        modelSelection: {
                          instanceId: "worker",
                          model: "custom-model",
                          options: [{ id: "effort", value: "high" }],
                        },
                        interactionMode: "plan",
                      }),
                    }
                  : null;
            if (calls === 2) {
              assert.include(messages.at(-1)?.content ?? "", '"effort"');
              assert.include(messages.at(-1)?.content ?? "", '"custom-model"');
            }
            const message: BotChatMessage = decision
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: `call-${calls}`, type: "function", function: decision }],
                }
              : { role: "assistant", content: "The scheduled review is running." };
            return { message, tokens: 100 };
          }),
      }),
    );
    const layer = Coordinator.layer.pipe(
      Layer.provide(model),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(storeLayer),
    );
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const coordinator = yield* Coordinator.Coordinator;
      yield* store.command(
        { type: "environment.create", requestId: "env", name: "Machine" },
        "hash",
      );
      yield* store.poll("env", "hash", poll);
      yield* store.command({
        type: "responsibility.save",
        requestId: "save",
        id: "review",
        revision: 0,
        title: "Review",
        instructions: "Review the project",
        environmentId: "env",
        projectId: "project",
        schedule: { type: "interval", everyMs: 60000 },
      });
      yield* store.command({ type: "responsibility.run", requestId: "run", id: "review" });
      assert.equal(
        (yield* store
          .command({ type: "responsibility.run", requestId: "duplicate", id: "review" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      for (let i = 0; i < 3; i++) {
        const job = yield* store.claim();
        assert.ok(job);
        yield* coordinator.run(job);
      }
      assert.equal(calls, 3);
      const snapshot = yield* store.snapshot();
      assert.equal(snapshot.messages.filter((message) => message.role === "user").length, 0);
      assert.equal(snapshot.tasks[0]?.modelSelection?.model, "custom-model");
      assert.equal(snapshot.tasks[0]?.interactionMode, "plan");
      assert.equal(snapshot.tasks[0]?.responsibilityId, "review");
      assert.equal(yield* store.claim(), null);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("persists the selected worker and options and rejects invented selections", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.Store;
    const task = (yield* store.snapshot()).tasks[0]!;
    assert.equal(task.modelSelection?.model, "custom-model");
    yield* TestClock.adjust("11 seconds");
    const commands = yield* store.poll("env", "hash", poll);
    assert.deepEqual(commands.commands[0]?.modelSelection, task.modelSelection);
    assert.equal(commands.commands[0]?.interactionMode, "plan");
    const result = yield* store
      .command({
        type: "task.start",
        requestId: "bad",
        title: "Bad",
        instructions: "Work",
        environmentId: "env",
        projectId: "project",
        isolated: false,
        modelSelection: {
          instanceId: poll.providers![0]!.instanceId,
          model: "custom-model",
          options: [{ id: "effort", value: "imaginary" }],
        },
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal((yield* store.snapshot()).tasks.length, 1);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("preserves project default options when an older executor has no worker catalogue", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const project = {
      id: "legacy-project",
      title: "Legacy project",
      instanceId: "legacy-worker",
      model: "legacy-model",
      options: [{ id: "effort", value: "high" }],
    };
    const input = { protocol: 1 as const, identity: "legacy-machine", projects: [project] };
    yield* store.command(
      { type: "environment.create", requestId: "legacy-env", name: "Legacy" },
      "hash",
    );
    yield* store.poll("legacy-env", "hash", input);
    yield* store.command({
      type: "task.start",
      requestId: "legacy-task",
      title: "Review",
      instructions: "Review the project",
      environmentId: "legacy-env",
      projectId: "legacy-project",
      isolated: false,
    });
    yield* TestClock.adjust("11 seconds");
    const commands = yield* store.poll("legacy-env", "hash", input);
    assert.deepEqual(commands.commands[0]?.modelSelection?.options, project.options);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("wakes once for a blocker and does not repeatedly prompt for unchanged input", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.Store;
    const input = yield* report("waiting_input", "Which account should I use?");
    yield* store.report("env", "hash", input);
    const job = yield* store.claim();
    assert.ok(job);
    assert.equal(job.kind, "task_wake");
    assert.equal(decodeWake(job.data).wake.reason, "blocked");
    yield* store.finish(job);
    yield* report("waiting_input", input.result);
    yield* TestClock.adjust("1 hour");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    assert.equal(yield* store.claim(), null);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("recovers a due progress review, backs off, and lets the bot pause timed checks", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.Store;
    yield* report("running");
    yield* wakeDue;
    yield* store.tick();
    const first = yield* store.claim();
    assert.ok(first);
    assert.equal(decodeWake(first.data).wake.reason, "stalled");
    yield* store.recover;
    const retry = yield* store.claim();
    assert.equal(retry?.id, first.id);
    assert.ok(retry);
    yield* store.finish(first);
    assert.equal((yield* store.snapshot()).jobs[0]?.state, "running");
    yield* store.finish(retry);
    yield* TestClock.adjust("5 minutes");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    assert.equal(yield* store.claim(), null);
    yield* TestClock.adjust("5 minutes");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    const second = yield* store.claim();
    assert.ok(second);
    yield* store.finish(second);
    yield* store.command({ type: "task.watch", requestId: "pause", id: "task", afterMs: null });
    yield* TestClock.adjust("1 hour");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    assert.equal(yield* store.claim(), null);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "keeps timed checks paused through progress and follow-up while retaining event wakes",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* Store.Store;
      yield* report("running");
      yield* wakeDue;
      const review = yield* store.claim();
      assert.ok(review);
      yield* store.command({ type: "task.watch", requestId: "pause", id: "task", afterMs: null });
      assert.equal(yield* store.isTaskWakeCurrent(decodeWake(review.data).wake), false);
      yield* store.finish(review);
      yield* report("running", "Material progress");
      yield* store.command({
        type: "task.followup",
        requestId: "continue",
        id: "task",
        text: "Verify the result",
      });
      yield* report("running", "Verifying");
      yield* TestClock.adjust("1 hour");
      yield* store.poll("env", "hash", poll);
      yield* store.tick();
      assert.equal(yield* store.claim(), null);
      yield* report("completed", "Verified result");
      const completion = yield* store.claim();
      assert.ok(completion);
      assert.equal(decodeWake(completion.data).wake.reason, "completed");
    }).pipe(Effect.provide(storeLayer)),
);

it.effect("resumes checks on request and preserves an explicitly long review interval", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.Store;
    yield* report("running");
    yield* store.command({ type: "task.watch", requestId: "pause", id: "task", afterMs: null });
    yield* store.command({
      type: "task.watch",
      requestId: "resume",
      id: "task",
      afterMs: 86400000,
    });
    yield* TestClock.adjust("24 hours");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    const first = yield* store.claim();
    assert.ok(first);
    yield* store.finish(first);
    yield* TestClock.adjust("1 hour");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    assert.equal(yield* store.claim(), null);
    yield* TestClock.adjust("23 hours");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    assert.ok(yield* store.claim());
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("repeated status polling does not postpone a progress review", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.Store;
    yield* report("running", "Working");
    yield* TestClock.adjust("4 minutes");
    yield* report("running", "Working");
    yield* TestClock.adjust("1 minute");
    yield* store.poll("env", "hash", poll);
    yield* store.tick();
    assert.ok(yield* store.claim());
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("invalidates old reviews on real progress, follow-up, completion and cancellation", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.Store;
    yield* report("running");
    yield* wakeDue;
    const review = yield* store.claim();
    assert.ok(review);
    const wake = decodeWake(review.data).wake;
    assert.equal(yield* store.isTaskWakeCurrent(wake), true);
    yield* report("running", "Found the relevant records");
    assert.equal(yield* store.isTaskWakeCurrent(wake), false);
    yield* store.finish(review);
    yield* report("completed", "A partial answer");
    const completed = yield* store.claim();
    assert.ok(completed);
    const completedWake = decodeWake(completed.data).wake;
    assert.equal(yield* store.isTaskWakeCurrent(completedWake), true);
    yield* store.command({
      type: "task.followup",
      requestId: "continue",
      id: "task",
      text: "Verify the denominator too",
    });
    assert.equal(yield* store.isTaskWakeCurrent(completedWake), false);
    yield* store.finish(completed);
    yield* report("running");
    yield* TestClock.adjust("5 minutes");
    yield* wakeDue;
    const last = yield* store.claim();
    assert.ok(last);
    yield* store.command({ type: "task.cancel", requestId: "cancel", id: "task" });
    assert.equal(yield* store.isTaskWakeCurrent(decodeWake(last.data).wake), false);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("wakes once while offline, and again when the executor reports its return", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.Store;
    yield* report("running");
    yield* TestClock.adjust("31 seconds");
    yield* store.tick();
    const offline = yield* store.claim();
    assert.ok(offline);
    assert.equal(decodeWake(offline.data).wake.reason, "offline");
    yield* store.finish(offline);
    yield* store.tick();
    assert.equal(yield* store.claim(), null);
    yield* report("running");
    const returned = yield* store.claim();
    assert.ok(returned);
    assert.equal(decodeWake(returned.data).wake.reason, "reconnected");
  }).pipe(Effect.provide(storeLayer)),
);

it.effect.each(["silent", "followup", "stale"])(
  "coordinates a %s wake without duplicate tasks or noisy replies",
  (mode) => {
    let calls = 0;
    const model = Layer.effect(
      Model.Model,
      Effect.gen(function* () {
        const store = yield* Store.Store;
        return Model.Model.of({
          complete: () =>
            Effect.gen(function* () {
              calls++;
              if (mode === "stale")
                yield* report("completed", "Verified answer").pipe(
                  Effect.provideService(Store.Store, store),
                );
              const message: BotChatMessage = {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "decision",
                    type: "function",
                    function: {
                      name: mode === "silent" ? "complete_silently" : "followup_task",
                      arguments:
                        mode === "silent"
                          ? "{}"
                          : JSON.stringify({
                              id: "task",
                              text: "Verify the answer with a second source",
                            }),
                    },
                  },
                ],
              };
              assert.equal((yield* store.snapshot()).tasks.length, 1);
              return { message, tokens: 100 };
            }),
        });
      }),
    );
    const layer = Coordinator.layer.pipe(
      Layer.provide(model),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(storeLayer),
    );
    return Effect.gen(function* () {
      yield* setup;
      const store = yield* Store.Store;
      const coordinator = yield* Coordinator.Coordinator;
      const sql = yield* SqlClient.SqlClient;
      yield* report("running");
      yield* wakeDue;
      const job = yield* store.claim();
      assert.ok(job);
      assert.equal(yield* coordinator.run(job), true);
      yield* store.finish(job);
      assert.equal(calls, 1);
      assert.equal(
        (yield* store.snapshot()).messages.filter((m) => m.role === "assistant").length,
        0,
      );
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM bridge_commands WHERE json_extract(data,'$.kind')='followup'`;
      assert.equal(rows[0]?.count, mode === "followup" ? 1 : 0);
      // A retried stale wake cannot issue another model call or side effect.
      if (mode !== "silent") assert.equal(yield* coordinator.run(job), true);
      assert.equal(calls, 1);
      if (mode === "silent") {
        yield* store.recover;
        assert.equal(yield* store.claim(), null);
      }
    }).pipe(Effect.provide(layer));
  },
);
