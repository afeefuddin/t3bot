import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as AgentSessions from "./AgentSessions.ts";
import * as Database from "./database.ts";
import * as Store from "./Store.ts";
import { BotConfig } from "./config.ts";

const layer = AgentSessions.layer.pipe(
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(Database.layer(":memory:")),
  Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [] })),
);

it.effect("deduplicates delegation and rejects reuse with a different task or parent", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSessions.AgentSessions;
    const sql = yield* SqlClient.SqlClient;
    const first = yield* agents.start("child", "Research", "Compare sources", "Context", "parent");
    assert.deepEqual(
      yield* agents.start("child", "Research", "Compare sources", "Context", "parent"),
      first,
    );
    for (const [instructions, parent] of [
      ["Different task", "parent"],
      ["Compare sources", "different-parent"],
    ]) {
      const result = yield* agents
        .start("child", "Research", instructions!, "Context", parent!)
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.category, "conflict");
    }
    assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent'`).length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("atomically completes once and ignores a late result after cancellation", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSessions.AgentSessions;
    const sql = yield* SqlClient.SqlClient;
    yield* agents.start("child", "Research", "Compare sources", "", "parent");
    yield* sql`CREATE TRIGGER fail_wake BEFORE INSERT ON jobs WHEN new.kind='agent_wake' BEGIN SELECT RAISE(ABORT,'wake failure'); END`;
    assert.equal((yield* agents.complete("child", "Evidence").pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* agents.get("child")).result, "");
    yield* sql`DROP TRIGGER fail_wake`;
    yield* agents.complete("child", "Evidence");
    yield* agents.complete("child", "Duplicate result");
    assert.equal((yield* agents.get("child")).result, "Evidence");
    assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent_wake'`).length, 1);
    const stored = (yield* sql<{
      data: string;
    }>`SELECT data FROM records WHERE kind='agent' AND id='child'`)[0]!;
    assert.notProperty(JSON.parse(stored.data), "status");
    yield* agents.start("cancel", "Research", "Compare sources", "", "parent");
    yield* agents.cancel("cancel");
    yield* agents.cancel("cancel");
    yield* agents.complete("cancel", "Too late");
    assert.equal((yield* agents.get("cancel")).status, "cancelled");
    assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent_wake'`).length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("wakes the coordinator on terminal child failure and ignores stale failure reports", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSessions.AgentSessions;
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    yield* agents.start("child", "Research", "Compare sources", "", "parent");
    const child = yield* store.claim("background");
    assert.ok(child);
    yield* store.finish(child, "budget");
    assert.equal((yield* agents.get("child")).status, "failed");
    const wake = yield* store.claim();
    assert.equal(wake?.kind, "agent_wake");
    assert.include(wake?.data ?? "", "budget");
    assert.include(wake?.data ?? "", "child");
    yield* store.finish(child, "budget");
    assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent_wake'`).length, 1);
    assert.equal((yield* store.snapshot()).messages.length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("caps child concurrency independently and fences expired leases", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSessions.AgentSessions;
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    for (const id of ["a", "b", "c"]) yield* agents.start(id, id, "Investigate", "", "parent");
    const children = yield* Effect.all(
      [store.claim("background"), store.claim("background"), store.claim("background")],
      { concurrency: "unbounded" },
    );
    assert.equal(children.filter(Boolean).length, 2);
    assert.equal(new Set(children.filter(Boolean).map((j) => j!.id)).size, 2);
    yield* store.command({ type: "message", requestId: "chat", text: "Hello" });
    const parent = yield* store.claim();
    assert.equal(parent?.kind, "turn");
    yield* sql`UPDATE jobs SET due_at=9999999999999 WHERE kind='agent' AND state='pending'`;
    yield* TestClock.adjust("181 seconds");
    const replacement = yield* store.claim("background");
    assert.ok(replacement);
    const old = children.find((j) => j?.id === replacement.id);
    assert.ok(old);
    yield* store.finish(old, "budget");
    const rows = yield* sql<{
      state: string;
      generation: number;
    }>`SELECT state,generation FROM jobs WHERE id=${replacement.id}`;
    assert.equal(rows[0]?.state, "running");
    assert.equal(rows[0]?.generation, replacement.generation);
    assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='agent_wake'`).length, 0);
  }).pipe(Effect.provide(layer)),
);
