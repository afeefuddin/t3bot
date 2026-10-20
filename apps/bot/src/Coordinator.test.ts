import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { BotConfig } from "./config.ts";
import * as Database from "./database.ts";
import * as Store from "./Store.ts";
import * as Model from "./Model.ts";
import * as Coordinator from "./Coordinator.ts";

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
                      content: null,
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
        1,
      );
    }).pipe(Effect.provide(layer));
  },
);
