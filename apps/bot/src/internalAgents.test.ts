import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as AgentSessions from "./AgentSessions.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as Coordinator from "./Coordinator.ts";
import * as Database from "./database.ts";
import * as Model from "./Model.ts";
import * as Store from "./Store.ts";
import * as Records from "./Records.ts";
import { BotConfig } from "./config.ts";

it.effect("delegates independent work to a hidden session without a project or approval", () => {
  let calls = 0;
  const model = Layer.succeed(
    Model.Model,
    Model.Model.of({
      complete: (_provider, messages, tools) =>
        Effect.sync(() => {
          calls++;
          if (calls === 1)
            return {
              tokens: 10,
              message: {
                role: "assistant" as const,
                content: null,
                tool_calls: [
                  {
                    id: "delegate",
                    type: "function" as const,
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({
                        title: "Compare sources",
                        instructions: "Compare public sources",
                        context: "Relevant user context",
                      }),
                    },
                  },
                ],
              },
            };
          if (
            messages[0]?.content?.startsWith("You are t3bot's internal worker") ||
            tools.length <= 1
          ) {
            assert.ok(
              !tools.some((t) =>
                ["start_task", "delegate_task", "remember"].includes(t.function.name),
              ),
            );
            assert.ok(!messages.some((m) => m.content?.includes("private unrelated conversation")));
            return {
              tokens: 10,
              message: { role: "assistant" as const, content: "Sources compared with evidence." },
            };
          }
          return {
            tokens: 10,
            message: { role: "assistant" as const, content: "Your result is ready." },
          };
        }),
    }),
  );
  const config = Layer.succeed(BotConfig, {
    provider: "test",
    providers: [{ id: "test", model: "test", endpoint: "http://test", apiKey: "" }],
  });
  const layer = Coordinator.layer.pipe(
    Layer.provide(model),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Database.layer(":memory:")),
    Layer.provide(config),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const store = yield* Store.Store;
    const coordinator = yield* Coordinator.Coordinator;
    const sql = yield* SqlClient.SqlClient;
    yield* store.append("old", "user", "private unrelated conversation");
    yield* store.command({
      type: "message",
      requestId: "request",
      text: "Compare public sources independently",
    });
    const parent = yield* store.claim();
    assert.ok(parent);
    yield* coordinator.run(parent);
    assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent'`).length, 1);
    assert.equal((yield* store.snapshot()).tasks.length, 0);
    assert.equal((yield* store.snapshot()).environments.length, 0);
    const parentContinuation = yield* store.claim();
    assert.ok(parentContinuation);
    yield* coordinator.run(parentContinuation);
    const child = yield* store.claim("background");
    assert.ok(child);
    const agents = yield* AgentSessions.AgentSessions;
    const agentId = (yield* sql<{ id: string }>`SELECT id FROM records WHERE kind='agent'`)[0]!.id;
    yield* store.recover;
    const resumed = yield* store.claim("background");
    assert.ok(resumed);
    assert.equal(resumed.id, child.id);
    yield* coordinator.run(resumed);
    const worker = yield* agents.get(agentId);
    assert.equal(worker.status, "completed");
    assert.equal(worker.result, "Sources compared with evidence.");
    assert.ok(!(yield* store.snapshot()).messages.some((m) => m.text === worker.result));
    const completion = yield* store.claim();
    assert.ok(completion);
    assert.equal(completion.kind, "agent_wake");
    yield* coordinator.run(completion);
    assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent_wake'`).length, 1);
    assert.equal((yield* store.snapshot()).messages.at(-1)?.text, "Your result is ready.");
  }).pipe(Effect.provide(layer));
});

it.effect.each(["agent", "summary", "memory_review"] as const)(
  "keeps the main conversation available while %s is waiting",
  (kind) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const config = Layer.succeed(BotConfig, {
        provider: "test",
        providers: [{ id: "test", model: "test", endpoint: "http://test", apiKey: "" }],
      });
      const model = Layer.succeed(
        Model.Model,
        Model.Model.of({
          complete: (_provider, messages, tools) =>
            Effect.gen(function* () {
              if (
                messages[0]?.content?.startsWith("You are t3bot's internal worker") ||
                tools.length <= 1
              ) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return { tokens: 10, message: { role: "assistant" as const, content: "Done." } };
            }),
        }),
      );
      const layer = Coordinator.layer.pipe(
        Layer.provide(model),
        Layer.provideMerge(Store.layer),
        Layer.provideMerge(Database.layer(":memory:")),
        Layer.provide(config),
        Layer.provide(FetchHttpClient.layer),
      );
      yield* Effect.gen(function* () {
        const agents = yield* AgentSessions.AgentSessions;
        const store = yield* Store.Store;
        const coordinator = yield* Coordinator.Coordinator;
        const records = yield* Records.Records;
        if (kind === "agent")
          yield* agents.start("independent", "Research", "Investigate", "", "origin");
        else
          yield* records.enqueue(
            "maintenance",
            kind,
            { text: "Maintenance context", messageId: "0" },
            0,
          );
        const child = yield* store.claim("background");
        assert.ok(child);
        const fiber = yield* Effect.forkScoped(coordinator.run(child));
        yield* Deferred.await(started);
        yield* store.command({ type: "message", requestId: "new", text: "Another question" });
        const parent = yield* store.claim();
        assert.ok(parent);
        assert.equal(parent.kind, "turn");
        yield* coordinator.run(parent);
        assert.equal((yield* store.snapshot()).messages.at(-1)?.text, "Done.");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        yield* store.finish(child);
        yield* agents.start("cancel", "Research", "Investigate", "", "origin");
        yield* agents.cancel("cancel");
        assert.equal((yield* agents.get("cancel")).status, "cancelled");
        assert.equal(yield* store.claim("background"), null);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["start_task", "remember", "delegate_task"])(
  "rejects an internal worker attempting %s at the execution boundary",
  (name) => {
    const model = Layer.succeed(
      Model.Model,
      Model.Model.of({
        complete: () =>
          Effect.succeed({
            tokens: 1,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "unauthorized", type: "function", function: { name, arguments: "{}" } },
              ],
            },
          }),
      }),
    );
    const layer = Coordinator.layer.pipe(
      Layer.provide(model),
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [] })),
      Layer.provide(FetchHttpClient.layer),
    );
    return Effect.gen(function* () {
      const agents = yield* AgentSessions.AgentSessions;
      const store = yield* Store.Store;
      const coordinator = yield* Coordinator.Coordinator;
      const sql = yield* SqlClient.SqlClient;
      yield* agents.start("child", "Investigate", "Research", "", "parent");
      const job = yield* store.claim("background");
      assert.ok(job);
      const result = yield* coordinator.run(job).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.category, "unauthorized");
      assert.equal((yield* store.snapshot()).tasks.length, 0);
      assert.equal((yield* store.snapshot()).memories.length, 0);
      assert.equal((yield* sql`SELECT id FROM records WHERE kind='agent'`).length, 1);
      assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent_wake'`).length, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("discards a cancelled worker's in-flight model decision before executing it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const model = Layer.succeed(
      Model.Model,
      Model.Model.of({
        complete: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return {
              tokens: 1,
              message: {
                role: "assistant" as const,
                content: null,
                tool_calls: [
                  {
                    id: "late",
                    type: "function" as const,
                    function: {
                      name: "terminal",
                      arguments: '{"command":"touch must-not-run","background":true}',
                    },
                  },
                ],
              },
            };
          }),
      }),
    );
    const layer = Coordinator.layer.pipe(
      Layer.provide(model),
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [] })),
      Layer.provide(FetchHttpClient.layer),
    );
    yield* Effect.gen(function* () {
      const agents = yield* AgentSessions.AgentSessions;
      const coordinator = yield* Coordinator.Coordinator;
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      yield* agents.start("child", "Investigate", "Research", "", "parent");
      const job = yield* store.claim("background");
      assert.ok(job);
      const fiber = yield* Effect.forkScoped(coordinator.run(job).pipe(Effect.result));
      yield* Deferred.await(started);
      yield* agents.cancel("child");
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(fiber))._tag, "Failure");
      assert.equal((yield* sql`SELECT id FROM records WHERE kind='process'`).length, 0);
      assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent_wake'`).length, 0);
      assert.equal((yield* agents.get("child")).status, "cancelled");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("suppresses a queued failure wake after the owner cancels the internal worker", () => {
  let calls = 0;
  const model = Layer.succeed(
    Model.Model,
    Model.Model.of({
      complete: () =>
        Effect.sync(() => {
          calls++;
          return {
            tokens: 1,
            message: { role: "assistant" as const, content: "Unexpected follow-up" },
          };
        }),
    }),
  );
  const layer = Coordinator.layer.pipe(
    Layer.provide(model),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Database.layer(":memory:")),
    Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [] })),
    Layer.provide(FetchHttpClient.layer),
  );
  return Effect.gen(function* () {
    const agents = yield* AgentSessions.AgentSessions;
    const store = yield* Store.Store;
    const coordinator = yield* Coordinator.Coordinator;
    yield* agents.start("child", "Research", "Investigate", "", "parent");
    const child = yield* store.claim("background");
    assert.ok(child);
    yield* store.finish(child, "budget");
    yield* agents.cancel("child");
    const wake = yield* store.claim();
    assert.equal(wake?.kind, "agent_wake");
    assert.ok(wake);
    assert.equal(yield* coordinator.run(wake), true);
    assert.equal(calls, 0);
    assert.equal((yield* store.snapshot()).messages.length, 0);
  }).pipe(Effect.provide(layer));
});
