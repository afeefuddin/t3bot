import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Processes from "./Processes.ts";
import * as Store from "./Store.ts";
import * as Records from "./Records.ts";
import * as Database from "./database.ts";
import * as AgentSessions from "./AgentSessions.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { toolRunner } from "./tools.ts";
import { BotConfig } from "./config.ts";

it.live(
  "runs unattended in the bot workspace, preserves receipts and never repeats an operation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-process-test-" });
      const config = Layer.succeed(BotConfig, { provider: "test", providers: [], workspace });
      const layer = Processes.layer.pipe(
        Layer.provideMerge(Store.layer),
        Layer.provideMerge(Database.layer(":memory:")),
        Layer.provide(config),
      );
      yield* Effect.gen(function* () {
        const processes = yield* Processes.Processes;
        const records = yield* Records.Records;
        const started = yield* processes.start(
          "one",
          "pwd; printf x >> count; printf 'result'",
          "owner",
          "source",
          false,
        );
        assert.equal(started.id, "one");
        const done = yield* processes.wait("one", "owner");
        assert.equal(done.status, "completed");
        assert.equal(done.exitCode, 0);
        assert.include(done.output, workspace);
        assert.include(done.output, "result");
        yield* processes.start(
          "one",
          "pwd; printf x >> count; printf 'result'",
          "owner",
          "source",
          false,
        );
        assert.equal(yield* fs.readFileString(`${workspace}/count`), "x");
        assert.equal(
          (yield* processes.get("one", "another-owner").pipe(Effect.result))._tag,
          "Failure",
        );
        yield* records.write("process", "crashed", 0, {
          id: "crashed",
          command: "touch should-not-exist",
          ownerId: "owner",
          sourceId: "source",
          status: "running",
          output: "",
          exitCode: null,
        });
        yield* processes.recover;
        const recovered = yield* processes.start(
          "crashed",
          "touch should-not-exist",
          "owner",
          "source",
          false,
        );
        assert.equal(recovered.status, "unknown");
        assert.equal(yield* fs.exists(`${workspace}/should-not-exist`), false);
        yield* processes.start("cancel", "exec tail -f /dev/null", "owner", "source", false);
        assert.equal((yield* processes.cancel("cancel", "owner")).status, "cancelled");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("can manage a main-conversation process from a later turn", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-process-turn-" });
    const layer = Layer.merge(Processes.layer, AgentSessions.layer).pipe(
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [], workspace })),
      Layer.provideMerge(FetchHttpClient.layer),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store.Store;
      const invoke = yield* toolRunner;
      yield* store.command({ type: "message", requestId: "first", text: "Run a command" });
      const first = yield* store.claim();
      assert.ok(first);
      const execution = (job: typeof first, requestId: string) => ({
        job,
        requestId,
        messageId: undefined,
        responsibilityId: undefined,
        goalId: undefined,
        commit: (command: Parameters<typeof store.command>[0]) => store.command(command),
      });
      yield* invoke(
        {
          id: "start",
          type: "function",
          function: {
            name: "terminal",
            arguments: JSON.stringify({ command: "printf cross-turn-result", background: true }),
          },
        },
        execution(first, "process-handle"),
      );
      yield* store.finish(first);
      yield* store.command({ type: "message", requestId: "second", text: "Check the command" });
      const second = yield* store.claim();
      assert.ok(second);
      assert.notEqual(first.id, second.id);
      const result = yield* invoke(
        {
          id: "wait",
          type: "function",
          function: {
            name: "process",
            arguments: JSON.stringify({ id: "process-handle", action: "wait" }),
          },
        },
        execution(second, "inspect-handle"),
      );
      assert.containSubset(result, {
        status: "completed",
        exitCode: 0,
        output: "cross-turn-result",
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  {
    name: "non-zero exit with stderr",
    command: "printf stdout; printf stderr >&2; exit 7",
    status: "failed",
    exitCode: 7,
  },
  {
    name: "large output",
    command: "node -e 'process.stdout.write(\"x\".repeat(24000))'",
    status: "completed",
    exitCode: 0,
  },
])("retains bounded evidence for $name", (test) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-process-evidence-" });
    const layer = Processes.layer.pipe(
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [], workspace })),
    );
    yield* Effect.gen(function* () {
      const processes = yield* Processes.Processes;
      yield* processes.start("evidence", test.command, "owner", "source", false);
      const result = yield* processes.wait("evidence", "owner");
      assert.equal(result.status, test.status);
      assert.equal(result.exitCode, test.exitCode);
      if (test.exitCode !== 0) {
        assert.include(result.output, "stdout");
        assert.include(result.output, "stderr");
      } else assert.equal(result.output, "x".repeat(16000));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("records a failed launch and releases its waiter", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-process-failure-" });
    const workspace = `${root}/file`;
    yield* fs.writeFileString(workspace, "not a directory");
    const layer = Processes.layer.pipe(
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(Layer.succeed(BotConfig, { provider: "test", providers: [], workspace })),
    );
    yield* Effect.gen(function* () {
      const processes = yield* Processes.Processes;
      yield* processes.start("failure", "printf must-not-run", "owner", "source", false);
      const result = yield* processes.wait("failure", "owner");
      assert.equal(result.status, "failed");
      assert.equal(result.exitCode, null);
      assert.include(result.output, "failed");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
