import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ChildProcessSpawner } from "effect/process";
import { stableId } from "@t3tools/shared/stableId";
import * as AgentSessions from "./AgentSessions.ts";
import * as Database from "./database.ts";
import * as Processes from "./Processes.ts";
import * as Records from "./Records.ts";
import * as Store from "./Store.ts";
import { BotConfig } from "./config.ts";
import { toolRunner } from "./tools.ts";

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-lifecycle-" });
  const started = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  let spawns = 0;
  const output = Stream.make(new TextEncoder().encode("evidence\n"));
  const spawner = ChildProcessSpawner.make(() =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        spawns++;
        yield* Deferred.succeed(started, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Deferred.await(exit),
          isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
          kill: () => Effect.asVoid(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(143))),
          stdin: Sink.drain,
          stdout: output,
          stderr: Stream.empty,
          all: output,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
      () => Effect.asVoid(Deferred.succeed(stopped, undefined)),
    ),
  );
  return {
    started,
    stopped,
    finish: (code = 0) => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(code)),
    spawns: () => spawns,
    layer: Layer.merge(Processes.layer, AgentSessions.layer).pipe(
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [], workspace })),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    ),
  };
});

it.effect.each([
  { command: 42, background: true },
  { command: { text: "command" }, background: true },
  { command: "command", background: "true" },
  { command: "command" },
])("rejects malformed terminal arguments before spawning: %j", (args) =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const store = yield* Store.Store;
      const invoke = yield* toolRunner;
      yield* store.command({ type: "message", requestId: "root", text: "Calculate" });
      const job = yield* store.claim();
      assert.ok(job);
      yield* h.finish();
      const result = yield* invoke(
        {
          id: "call",
          type: "function",
          function: { name: "terminal", arguments: JSON.stringify(args) },
        },
        {
          job,
          requestId: "invalid",
          messageId: "root",
          responsibilityId: undefined,
          goalId: undefined,
          commit: (input) => store.command(input),
        },
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(h.spawns(), 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "records completion and its wake atomically and retries persistence without rerunning",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const processes = yield* Processes.Processes;
        const sql = yield* SqlClient.SqlClient;
        yield* processes.start("receipt", "command", "main", "source");
        yield* Deferred.await(h.started);
        yield* sql`CREATE TRIGGER fail_wake BEFORE INSERT ON jobs WHEN new.kind='process_wake' BEGIN SELECT RAISE(ABORT,'wake failure'); END`;
        yield* h.finish();
        const done = yield* processes.wait("receipt", "main");
        assert.equal(done.status, "completed");
        const stored = (yield* sql<{
          status: string;
        }>`SELECT json_extract(data,'$.status') AS status FROM records WHERE kind='process' AND id='receipt'`)[0];
        assert.equal(stored?.status, "running");
        yield* sql`DROP TRIGGER fail_wake`;
        yield* processes.flush;
        yield* processes.flush;
        assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='process_wake'`).length, 1);
        assert.equal((yield* processes.get("receipt")).exitCode, 0);
        assert.equal(h.spawns(), 1);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recovers every interrupted process even after more than 1000 newer receipts", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const processes = yield* Processes.Processes;
      const records = yield* Records.Records;
      const sql = yield* SqlClient.SqlClient;
      yield* records.write("process", "old", 0, {
        id: "old",
        command: "command",
        ownerId: "main",
        sourceId: "source",
        status: "running",
        output: "",
        exitCode: null,
      });
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO records(kind,id,revision,data) SELECT 'process','new-'||x,0,json_object('id','new-'||x,'command','command','ownerId','main','sourceId','source','status','completed','output','','exitCode',0) FROM n`;
      yield* processes.recover;
      yield* processes.recover;
      assert.equal((yield* processes.get("old")).status, "unknown");
      assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='process_wake'`).length, 1);
      assert.equal(h.spawns(), 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a process launch after its internal owner was cancelled", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const agents = yield* AgentSessions.AgentSessions;
      const processes = yield* Processes.Processes;
      yield* agents.start("child", "Research", "Investigate", "", "parent");
      yield* agents.cancel("child");
      const result = yield* processes
        .start("late", "command", stableId("agent", "child"), "parent", false)
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(h.spawns(), 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "deduplicates concurrent starts and protects the original command and delivery route",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const processes = yield* Processes.Processes;
        yield* Effect.all(
          [
            processes.start("one", "command", "main", "source", false),
            processes.start("one", "command", "main", "source", false),
          ],
          { concurrency: "unbounded" },
        );
        yield* Deferred.await(h.started);
        assert.equal(h.spawns(), 1);
        for (const [command, owner, source] of [
          ["other command", "main", "source"],
          ["command", "other owner", "source"],
          ["command", "main", "other source"],
        ]) {
          const result = yield* processes
            .start("one", command!, owner!, source!, false)
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
        }
        yield* processes.cancel("one", "main");
        yield* Deferred.await(h.stopped);
        assert.equal((yield* processes.cancel("one", "main")).status, "cancelled");
        assert.equal(h.spawns(), 1);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not queue a second reply for a command awaited in the main conversation", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      const invoke = yield* toolRunner;
      yield* store.command({ type: "message", requestId: "root", text: "Calculate" });
      const job = yield* store.claim();
      assert.ok(job);
      yield* h.finish();
      yield* invoke(
        {
          id: "call",
          type: "function",
          function: {
            name: "terminal",
            arguments: JSON.stringify({ command: "command", background: false }),
          },
        },
        {
          job,
          requestId: "foreground",
          messageId: "root",
          responsibilityId: undefined,
          goalId: undefined,
          commit: (input) => store.command(input),
        },
      );
      assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='process_wake'`).length, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("notifies once when a foreground wait returns a still-running handle", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const processes = yield* Processes.Processes;
      const sql = yield* SqlClient.SqlClient;
      yield* processes.start("slow", "command", "main", "source", false);
      yield* Deferred.await(h.started);
      const waiting = yield* Effect.forkScoped(processes.wait("slow", "main", true));
      yield* TestClock.adjust("21 seconds");
      assert.equal((yield* Fiber.join(waiting)).status, "running");
      yield* h.finish(7);
      const result = yield* processes.wait("slow", "main");
      assert.equal(result.status, "failed");
      assert.equal(result.exitCode, 7);
      assert.equal((yield* sql`SELECT id FROM jobs WHERE kind='process_wake'`).length, 1);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "stops only the cancelled owner's processes and closes processes with the service scope",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const processes = yield* Processes.Processes;
          yield* processes.start("a", "command", "owner-a", "source", false);
          yield* processes.start("b", "command", "owner-b", "source", false);
          yield* Deferred.await(h.started);
          yield* processes.cancelOwner("owner-a");
          assert.equal((yield* processes.get("a")).status, "cancelled");
          assert.equal((yield* processes.get("b")).status, "running");
        }).pipe(Effect.provide(h.layer)),
      );
      yield* Deferred.await(h.stopped);
    }).pipe(Effect.provide(NodeServices.layer)),
);
