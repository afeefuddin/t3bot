import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { BotConfig } from "./config.ts";
import * as Database from "./database.ts";
import * as Store from "./Store.ts";
import * as Model from "./Model.ts";
import * as Coordinator from "./Coordinator.ts";
import * as Worker from "./Worker.ts";

const conversationLayer = (model: Model.Model["Service"], http = FetchHttpClient.layer) =>
  Worker.layer.pipe(
    Layer.provideMerge(Coordinator.layer),
    Layer.provideMerge(Store.layer),
    Layer.provide(Layer.succeed(Model.Model, model)),
    Layer.provide(http),
    Layer.provideMerge(Database.layer(":memory:")),
    Layer.provide(
      Layer.succeed(BotConfig, {
        provider: "fixture",
        providers: [{ id: "fixture", model: "fixture", endpoint: "http://fixture", apiKey: "" }],
      }),
    ),
  );

it.effect(
  "acknowledges before the model and publishes progress before a blocked tool finishes",
  () =>
    Effect.gen(function* () {
      const fetching = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const model = Model.Model.of({
        complete: () =>
          Effect.sync(() => ({
            tokens: 10,
            message:
              ++calls === 1
                ? {
                    role: "assistant" as const,
                    content: "Checking the source.",
                    tool_calls: [
                      {
                        id: "lookup",
                        type: "function" as const,
                        function: {
                          name: "web_fetch",
                          arguments: '{"url":"https://example.test"}',
                        },
                      },
                    ],
                  }
                : { role: "assistant" as const, content: "The source reports 24°C." },
          })),
      });
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(fetching, undefined);
            yield* Deferred.await(release);
            return HttpClientResponse.fromWeb(request, new Response("24°C"));
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const store = yield* Store.Store;
        const coordinator = yield* Coordinator.Coordinator;
        yield* store.command({ type: "message", requestId: "lookup", text: "Check this source" });
        assert.equal(calls, 0);
        assert.deepEqual(
          (yield* store.snapshot()).messages.map(({ role, text }) => ({ role, text })),
          [
            { role: "user", text: "Check this source" },
            { role: "assistant", text: "Okay, I’m on it." },
          ],
        );
        const job = yield* store.claim();
        assert.ok(job);
        const running = yield* Effect.forkScoped(coordinator.run(job));
        yield* Deferred.await(fetching);
        assert.equal((yield* store.snapshot()).messages.at(-1)?.text, "Checking the source.");
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Fiber.join(running), false);
        const continuation = yield* store.claim();
        assert.ok(continuation);
        assert.equal(yield* coordinator.run(continuation), true);
        assert.deepEqual(
          (yield* store.snapshot()).messages.map((message) => message.text),
          [
            "Check this source",
            "Okay, I’m on it.",
            "Checking the source.",
            "The source reports 24°C.",
          ],
        );
      }).pipe(Effect.provide(conversationLayer(model, http)));
    }),
);

it.effect("sets a reminder quietly after acknowledging and delivers it after recovery", () => {
  let calls = 0;
  const model = Model.Model.of({
    complete: () =>
      Effect.sync(() => ({
        tokens: 10,
        message:
          ++calls <= 2
            ? {
                role: "assistant" as const,
                content: null,
                tool_calls: [
                  {
                    id: `reminder-${calls}`,
                    type: "function" as const,
                    function:
                      calls === 1
                        ? {
                            name: "save_responsibility",
                            arguments: JSON.stringify({
                              id: "water",
                              revision: 0,
                              title: "Drink water",
                              instructions: "Remind the owner to drink water",
                              environmentId: null,
                              projectId: null,
                              schedule: { type: "once", at: 60000 },
                            }),
                          }
                        : { name: "complete_silently", arguments: "{}" },
                  },
                ],
              }
            : { role: "assistant" as const, content: "Time to drink water." },
      })),
  });
  return Effect.gen(function* () {
    const store = yield* Store.Store;
    const worker = yield* Worker.Worker;
    yield* store.command({
      type: "settings",
      requestId: "settings",
      provider: "fixture",
      autoMemory: false,
    });
    yield* store.command({
      type: "message",
      requestId: "water",
      text: "Remind me to drink water in a minute",
    });
    assert.equal(calls, 0);
    assert.equal((yield* store.snapshot()).messages.at(-1)?.text, "Okay, I’m on it.");
    yield* worker.step;
    yield* worker.step;
    assert.equal((yield* store.snapshot()).responsibilities[0]?.nextAt, 60000);
    assert.equal((yield* store.snapshot()).messages.length, 2);
    yield* store.recover;
    yield* TestClock.adjust("1 minute");
    yield* worker.drain;
    assert.deepEqual(
      (yield* store.snapshot()).messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
      ["Okay, I’m on it.", "Time to drink water."],
    );
    assert.equal((yield* store.snapshot()).tasks.length, 0);
    assert.equal(calls, 3);
  }).pipe(Effect.provide(conversationLayer(model)));
});

it.effect.each([false, true])(
  "rejects silent completion without a successful tool result (failed tool=%s)",
  (failedTool) => {
    let calls = 0;
    const model = Model.Model.of({
      complete: () =>
        Effect.sync(() => ({
          tokens: 10,
          message: {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              {
                id: `call-${++calls}`,
                type: "function" as const,
                function:
                  failedTool && calls === 1
                    ? { name: "web_fetch", arguments: '{"url":"file:///not-a-web-page"}' }
                    : { name: "complete_silently", arguments: "{}" },
              },
            ],
          },
        })),
    });
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const coordinator = yield* Coordinator.Coordinator;
      yield* store.command({ type: "message", requestId: "request", text: "Do this" });
      let job = yield* store.claim();
      assert.ok(job);
      if (failedTool) {
        assert.equal(yield* coordinator.run(job), false);
        job = yield* store.claim();
        assert.ok(job);
      }
      const result = yield* coordinator.run(job).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.category, "invalid");
    }).pipe(Effect.provide(conversationLayer(model)));
  },
);

it.effect(
  "replays a saved tool response after a failed checkpoint without launching a second task",
  () => {
    let calls = 0;
    const model = Layer.succeed(
      Model.Model,
      Model.Model.of({
        complete: () =>
          Effect.sync(() => {
            calls++;
            return {
              tokens: 100,
              message:
                calls === 1
                  ? {
                      role: "assistant" as const,
                      content: "I’m starting the project work.",
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function" as const,
                          function: {
                            name: "start_task",
                            arguments: JSON.stringify({
                              title: "Cloud research",
                              instructions: "Research this",
                              environmentId: "env",
                              projectId: "project",
                              isolated: false,
                            }),
                          },
                        },
                      ],
                    }
                  : { role: "assistant" as const, content: "Your task is running." },
            };
          }),
      }),
    );
    const config = Layer.succeed(
      BotConfig,
      BotConfig.of({
        provider: "fixture",
        providers: [
          {
            id: "fixture",
            endpoint: "http://localhost",
            model: "fixture",
            apiKeyEnv: "FIXTURE_KEY",
            apiKey: "fixture",
          },
        ],
      }),
    );
    const layer = Coordinator.layer.pipe(
      Layer.provideMerge(Store.layer),
      Layer.provide(model),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(config),
    );
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const coordinator = yield* Coordinator.Coordinator;
      const sql = yield* SqlClient.SqlClient;
      yield* store.command({ type: "environment.create", requestId: "env", name: "Cloud" }, "hash");
      yield* store.poll("env", "hash", {
        protocol: 1,
        identity: "native-env",
        projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
      });
      yield* store.command({
        type: "message",
        requestId: "request",
        text: "Research this in the cloud",
      });
      const job = yield* store.claim();
      assert.ok(job);
      yield* sql`CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF messages ON turns BEGIN SELECT RAISE(ABORT,'simulated checkpoint crash'); END`;
      assert.equal((yield* coordinator.run(job).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* store.snapshot()).tasks.length, 1);
      assert.equal(
        (yield* store.snapshot()).messages.at(-1)?.text,
        "I’m starting the project work.",
      );
      yield* sql`DROP TRIGGER fail_checkpoint`;
      assert.equal(yield* coordinator.run(job), false);
      assert.equal(calls, 1);
      assert.equal((yield* store.snapshot()).tasks.length, 1);
      const continuation = yield* store.claim();
      assert.ok(continuation);
      assert.equal(yield* coordinator.run(continuation), true);
      yield* store.finish(continuation);
      assert.equal(calls, 2);
      assert.equal(
        (yield* store.snapshot()).messages.filter((m) => m.role === "assistant").length,
        3,
      );
    }).pipe(Effect.provide(layer));
  },
);
