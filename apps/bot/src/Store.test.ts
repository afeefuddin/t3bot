import {
  BotSnapshot,
  BotBridgePollResult,
  BotCommand,
  DEFAULT_BOT_AVATAR,
} from "@t3tools/contracts/bot";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { BotConfig } from "./config.ts";
import * as Database from "./database.ts";
import * as Store from "./Store.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(BotSnapshot);
const decodeCommand = Schema.decodeUnknownEffect(BotCommand);
const decodePoll = Schema.decodeUnknownEffect(BotBridgePollResult);
const config = Layer.succeed(
  BotConfig,
  BotConfig.of({
    providers: [
      {
        id: "test",
        endpoint: "http://localhost",
        model: "fixture",
        apiKeyEnv: "FIXTURE_KEY",
        apiKey: "fixture",
      },
    ],
    provider: "test",
  }),
);
const layer = Store.layer.pipe(
  Layer.provideMerge(Database.layer(":memory:")),
  Layer.provide(config),
);
const pair = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* store.command({ type: "environment.create", requestId: "env", name: "Cloud" }, "hash");
  yield* store.poll("env", "hash", {
    protocol: 1,
    identity: "actual-env",
    projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
  });
});

it.effect(
  "saves the bot avatar independently of provider settings and resets it without creating work",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      assert.deepEqual((yield* store.snapshot()).avatar, DEFAULT_BOT_AVATAR);
      const avatar = {
        ...DEFAULT_BOT_AVATAR,
        eyes: "happy",
        color: "moss",
        antenna: false,
      } as const;
      const command = { type: "avatar.save", requestId: "avatar", avatar } as const;
      yield* store.command(command);
      yield* store.command(command);
      yield* store.command({
        type: "settings",
        requestId: "provider",
        provider: "test",
        autoMemory: false,
      });
      yield* store.recover;
      const saved = yield* store.snapshot();
      assert.deepEqual(saved.avatar, avatar);
      assert.equal(saved.autoMemory, false);
      assert.equal(saved.jobs.length, 0);
      assert.equal(saved.messages.length, 0);
      assert.equal(
        (yield* store.command({ ...command, avatar: DEFAULT_BOT_AVATAR }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* store.command({ type: "avatar.save", requestId: "reset-avatar", avatar: null });
      assert.deepEqual((yield* store.snapshot()).avatar, DEFAULT_BOT_AVATAR);
      assert.equal((yield* store.snapshot()).autoMemory, false);
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects invalid avatar designs at the command boundary", () =>
  Effect.gen(function* () {
    const result = yield* decodeCommand({
      type: "avatar.save",
      requestId: "invalid-avatar",
      avatar: { ...DEFAULT_BOT_AVATAR, color: "url(https://untrusted)" },
    }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("does not acknowledge or retain a message if its pending work cannot be recorded", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.Store;
    yield* sql`CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END`;
    const result = yield* store
      .command({ type: "message", requestId: "atomic", text: "Do work" })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal((yield* store.snapshot()).messages.length, 0);
    const receipts = yield* sql`SELECT id FROM receipts`;
    assert.equal(receipts.length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "cancels an offline task before its first dispatch without leaving work to run on reconnect",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* pair;
      yield* store.command({
        type: "task.start",
        requestId: "offline",
        title: "Local task",
        instructions: "Work locally",
        environmentId: "env",
        projectId: "project",
        isolated: false,
      });
      yield* TestClock.adjust("31 seconds");
      yield* store.tick();
      assert.equal((yield* store.snapshot()).tasks[0]?.status, "waiting_environment");
      yield* store.command({ type: "task.cancel", requestId: "stop-offline", id: "offline" });
      assert.equal((yield* store.snapshot()).tasks[0]?.status, "cancelled");
      const reconnect = yield* store.poll("env", "hash", {
        protocol: 1,
        identity: "actual-env",
        projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
      });
      assert.equal(reconnect.commands.length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "persists a message and its work atomically, deduplicates retries, and rejects changed request bodies",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const command = { type: "message", requestId: "hello", text: "Research this" } as const;
      yield* store.command(command);
      yield* store.command(command);
      const snapshot = yield* store.snapshot();
      assert.equal(snapshot.messages.length, 1);
      assert.equal(snapshot.jobs.length, 1);
      const result = yield* store.command({ ...command, text: "Different" }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(layer)),
);

it.effect("reclaims an expired lease and prevents an old worker from completing it", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* store.command({ type: "message", requestId: "lease", text: "Hi" });
    const first = yield* store.claim();
    assert.ok(first);
    assert.equal(yield* store.claim(), null);
    yield* TestClock.adjust("181 seconds");
    const next = yield* store.claim();
    assert.ok(next);
    assert.equal(next.generation, first.generation + 1);
    yield* store.finish(first);
    assert.equal((yield* store.snapshot()).jobs[0]?.state, "running");
    yield* store.finish(next);
    assert.equal((yield* store.snapshot()).jobs.length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps a launch pending after a lost acknowledgement and applies a duplicate result once",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* pair;
      yield* store.command({
        type: "task.start",
        requestId: "task",
        title: "Research",
        instructions: "Find evidence",
        environmentId: "env",
        projectId: "project",
        isolated: false,
      });
      yield* TestClock.adjust("11 seconds");
      const input = {
        protocol: 1 as const,
        identity: "actual-env",
        projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
      };
      const first = yield* store.poll("env", "hash", input);
      assert.equal(first.commands.length, 1);
      yield* TestClock.adjust("11 seconds");
      const retry = yield* store.poll("env", "hash", input);
      assert.equal(retry.commands[0]?.id, first.commands[0]?.id);
      const report = {
        commandId: first.commands[0]!.id,
        taskId: "task",
        threadId: "task",
        runId: "run",
        status: "completed" as const,
        result: "Evidence found",
      };
      yield* store.report("env", "hash", report);
      yield* store.report("env", "hash", report);
      const snapshot = yield* store.snapshot();
      assert.equal(snapshot.tasks[0]?.status, "completed");
      assert.equal(
        snapshot.messages.filter((m) => m.role === "system" && m.text.includes("completed")).length,
        1,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("ignores old-run results after a follow-up and blocks revoked environments", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* pair;
    yield* store.command({
      type: "task.start",
      requestId: "task",
      title: "Task",
      instructions: "Do work",
      environmentId: "env",
      projectId: "project",
      isolated: false,
    });
    yield* TestClock.adjust("11 seconds");
    const poll = yield* store.poll("env", "hash", {
      protocol: 1,
      identity: "actual-env",
      projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
    });
    yield* store.report("env", "hash", {
      commandId: poll.commands[0]!.id,
      taskId: "task",
      threadId: "task",
      runId: "old",
      status: "running",
      result: "",
    });
    yield* store.command({
      type: "task.followup",
      requestId: "followup",
      id: "task",
      text: "Additional work",
    });
    yield* store.report("env", "hash", {
      commandId: poll.commands[0]!.id,
      taskId: "task",
      threadId: "task",
      runId: "old",
      status: "completed",
      result: "Old result",
    });
    assert.equal((yield* store.snapshot()).tasks[0]?.status, "queued");
    yield* store.command({ type: "environment.revoke", requestId: "revoke", id: "env" });
    assert.equal(
      (yield* store
        .poll("env", "hash", { protocol: 1, identity: "actual-env", projects: [] })
        .pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("does not deliver an unstarted responsibility task after pause", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* pair;
    yield* store.command({
      type: "responsibility.save",
      requestId: "save",
      id: "daily",
      revision: 0,
      title: "Review",
      instructions: "Review this project",
      environmentId: "env",
      projectId: "project",
      schedule: { type: "interval", everyMs: 60000 },
    });
    yield* TestClock.adjust("2 minutes");
    yield* store.tick();
    const occurrence = yield* store.claim();
    assert.ok(occurrence);
    yield* store.command(
      {
        type: "task.start",
        requestId: occurrence.id,
        title: "Review",
        instructions: "Review this project",
        environmentId: "env",
        projectId: "project",
        isolated: false,
      },
      undefined,
      { responsibilityId: "daily", revision: 1 },
    );
    assert.equal((yield* store.snapshot()).tasks.length, 1);
    yield* store.command({
      type: "responsibility.state",
      requestId: "pause",
      id: "daily",
      revision: 1,
      state: "paused",
    });
    const poll = yield* store.poll("env", "hash", {
      protocol: 1,
      identity: "actual-env",
      projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
    });
    assert.equal(poll.commands.length, 0);
    assert.equal((yield* store.snapshot()).tasks[0]?.status, "cancelled");
    yield* TestClock.adjust("1 hour");
    yield* store.tick();
    assert.equal((yield* store.snapshot()).tasks.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "coalesces missed intervals and prevents stale correction or capture after forgetting",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* store.command({
        type: "responsibility.save",
        requestId: "save",
        id: "remind",
        revision: 0,
        title: "Check in",
        instructions: "Check in with me",
        environmentId: null,
        projectId: null,
        schedule: { type: "interval", everyMs: 60000 },
      });
      yield* TestClock.adjust("4 hours");
      yield* store.tick();
      yield* store.tick();
      assert.equal((yield* store.snapshot()).jobs.length, 1);
      yield* store.command({
        type: "memory.save",
        requestId: "remember",
        id: "format",
        revision: 0,
        scope: "user",
        text: "Short reports",
        source: "message",
      });
      yield* store.command({
        type: "memory.save",
        requestId: "correct",
        id: "format",
        revision: 1,
        scope: "user",
        text: "Detailed reports",
        source: "message",
      });
      assert.equal(
        (yield* store
          .command({
            type: "memory.save",
            requestId: "stale",
            id: "format",
            revision: 1,
            scope: "user",
            text: "Old report",
            source: "message",
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* store.command({
        type: "memory.forget",
        requestId: "forget",
        id: "format",
        revision: 2,
      });
      assert.equal(
        (yield* store
          .command({
            type: "memory.save",
            requestId: "recapture",
            id: "another-key",
            revision: 0,
            scope: "user",
            text: "Detailed reports",
            source: "message",
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* store.snapshot()).memories.length, 0);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM records WHERE kind='memory'`;
      assert.equal(rows[0]?.count, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps long task identifiers valid through delivery, follow-ups, and result notifications",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* pair;
      const taskId = "t".repeat(160);
      yield* TestClock.adjust("11 seconds");
      yield* store.command({
        type: "task.start",
        requestId: taskId,
        title: "Long identifier",
        instructions: "Work",
        environmentId: "env",
        projectId: "project",
        isolated: false,
      });
      const input = {
        protocol: 1 as const,
        identity: "actual-env",
        projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
      };
      for (let generation = 0; generation < 3; generation++) {
        const poll = yield* store.poll("env", "hash", input);
        yield* decodePoll(poll);
        const command = poll.commands[0];
        assert.ok(command);
        yield* store.report("env", "hash", {
          commandId: command.id,
          taskId,
          threadId: taskId,
          runId: `run-${generation}`,
          status: "completed",
          result: "Finished",
        });
        const snapshot = yield* store.snapshot();
        yield* decodeSnapshot(snapshot);
        assert.equal(snapshot.tasks[0]?.generation, generation);
        if (generation < 2)
          yield* store.command({
            type: "task.followup",
            requestId: `${generation}`.repeat(160),
            id: taskId,
            text: "Continue",
          });
      }
      assert.equal((yield* store.snapshot()).messages.length, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "retains an offline initial launch when a premature follow-up is rejected and supplies only applicable memories",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* pair;
      yield* TestClock.adjust("11 seconds");
      for (const [id, scope, text] of [
        ["global", "user", "Keep reports concise"],
        ["local", "environment:env", "Use local conventions"],
        ["foreign", "environment:other", "Private other environment note"],
      ] as const) {
        yield* store.command({
          type: "memory.save",
          requestId: `save-${id}`,
          id,
          scope,
          text,
          revision: 0,
        });
      }
      yield* store.command({
        type: "task.start",
        requestId: "initial",
        title: "Task",
        instructions: "Work",
        environmentId: "env",
        projectId: "project",
        isolated: false,
      });
      const result = yield* store
        .command({
          type: "task.followup",
          requestId: "too-early",
          id: "initial",
          text: "More work",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const poll = yield* store.poll("env", "hash", {
        protocol: 1,
        identity: "actual-env",
        projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
      });
      assert.equal(poll.commands[0]?.kind, "start");
      assert.ok(poll.commands[0]?.text.includes("Keep reports concise"));
      assert.ok(poll.commands[0]?.text.includes("Use local conventions"));
      assert.ok(!poll.commands[0]?.text.includes("Private other environment note"));
    }).pipe(Effect.provide(layer)),
);

it.effect("retains the responsibility scope on the coordinator wake after a worker result", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* pair;
    yield* TestClock.adjust("11 seconds");
    yield* store.command({
      type: "responsibility.save",
      requestId: "save-r",
      id: "r",
      revision: 0,
      title: "Review",
      instructions: "Review this project",
      environmentId: "env",
      projectId: "project",
      schedule: { type: "interval", everyMs: 60000 },
    });
    yield* store.command(
      {
        type: "task.start",
        requestId: "run-r",
        title: "Review",
        instructions: "Review this project",
        environmentId: "env",
        projectId: "project",
        isolated: false,
      },
      undefined,
      { responsibilityId: "r", revision: 1 },
    );
    const poll = yield* store.poll("env", "hash", {
      protocol: 1,
      identity: "actual-env",
      projects: [{ id: "project", title: "Workspace", instanceId: "codex", model: "fixture" }],
    });
    const command = poll.commands[0];
    assert.ok(command);
    yield* store.report("env", "hash", {
      commandId: command.id,
      taskId: command.taskId,
      threadId: command.threadId,
      runId: "run",
      status: "completed",
      result: "Review complete",
    });
    const wake = yield* store.claim();
    assert.ok(wake);
    const payload = JSON.parse(wake.data) as { responsibilityId: string; revision: number };
    assert.equal(payload.responsibilityId, "r");
    assert.equal(payload.revision, 1);
    const escaped = yield* store
      .command(
        {
          type: "task.start",
          requestId: "escape",
          title: "Other",
          instructions: "Work",
          environmentId: "other",
          projectId: "project",
          isolated: false,
        },
        undefined,
        { responsibilityId: payload.responsibilityId, revision: payload.revision },
      )
      .pipe(Effect.result);
    assert.equal(escaped._tag, "Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("falls back to the configured provider when a saved provider is removed", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO records(kind,id,revision,data) VALUES('settings','main',0,'{"provider":"removed","autoMemory":false}')`;
    const snapshot = yield* store.snapshot();
    assert.equal(snapshot.provider, "test");
    assert.equal(snapshot.autoMemory, false);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "publishes reply transitions so clients can show queued, thinking, retrying, and settled state",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* store.command({ type: "message", requestId: "progress", text: "Hi" });
      const queued = yield* store.snapshot();
      assert.equal(queued.jobs[0]?.state, "pending");
      const first = yield* store.claim();
      assert.ok(first);
      const running = yield* store.snapshot();
      assert.isAbove(running.cursor, queued.cursor);
      assert.equal(running.jobs[0]?.state, "running");
      assert.equal(yield* store.claim(), null);
      assert.equal(yield* store.changed(0), running.cursor);
      yield* store.finish(first, "unavailable");
      const retrying = yield* store.snapshot();
      assert.isAbove(retrying.cursor, running.cursor);
      assert.equal(retrying.jobs[0]?.error, "unavailable");
      yield* TestClock.adjust("5 seconds");
      const retry = yield* store.claim();
      assert.ok(retry);
      yield* store.finish(retry);
      const settled = yield* store.snapshot();
      assert.isAbove(settled.cursor, retrying.cursor);
      assert.equal(settled.jobs.length, 0);
    }).pipe(Effect.provide(layer)),
);
