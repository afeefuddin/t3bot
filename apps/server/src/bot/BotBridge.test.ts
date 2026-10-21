import * as BotConnection from "./BotConnection.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  EnvironmentId,
  OrchestrationV2ThreadProjectionJson,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ThreadShellJson,
  OrchestrationV2RunJson,
  OrchestrationV2ConversationMessageJson,
  ServerProvider,
} from "@t3tools/contracts";
import type { BotBridgeCommand } from "@t3tools/contracts/bot";
import * as Bridge from "./BotBridge.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";

const now = "2026-10-19T00:00:00.000Z";
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  showInteractionModeToggle: true,
  models: [
    { slug: "fixture", name: "Default", isCustom: false, capabilities: null },
    {
      slug: "custom-worker",
      name: "Custom worker",
      isCustom: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
});
const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson)({
  thread: {
    id: "task",
    projectId: "project",
    title: "Task",
    createdBy: "agent",
    creationSource: "server",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "task" },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
});
const command: BotBridgeCommand = {
  id: "c".repeat(160),
  taskId: "task",
  generation: 0,
  kind: "start",
  projectId: "project",
  threadId: "task",
  runId: null,
  text: "Work",
  title: "Task",
  isolated: true,
};

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);

function harness(
  options: {
    allowed?: string;
    userThread?: boolean;
    missing?: boolean;
    noDefault?: boolean;
    unavailable?: boolean;
    busy?: "starting" | "running";
  } = {},
) {
  const launches: Launch.ThreadLaunchInput[] = [];
  const polls: Array<Record<string, unknown>> = [];
  const sends: Threads.ThreadManagementSendInput[] = [];
  const windowReads: Array<{ threadId: string; rowLimit: number }> = [];
  const context = decodeTurnItem({
    id: "context",
    threadId: "task",
    runId: "run",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    type: "assistant_message",
    status: "completed",
    title: null,
    messageId: "context-message",
    text: "Recent project context",
    streaming: false,
    startedAt: null,
    completedAt: now,
    updatedAt: now,
  });
  if (context.type !== "assistant_message") throw new Error("Expected assistant context");
  const visibleContext = {
    position: 0,
    visibility: "local" as const,
    sourceThreadId: context.threadId,
    sourceItemId: context.id,
    item: context,
  };
  const run = decodeRun({
    id: "run",
    threadId: "task",
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection: projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: "message",
    rootNodeId: null,
    activeAttemptId: null,
    status: options.busy ?? "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  });
  let currentProjection: typeof projection = {
    ...projection,
    visibleTurnItems: [visibleContext],
    thread: {
      ...projection.thread,
      createdBy: options.userThread ? ("user" as const) : ("agent" as const),
    },
    runs: options.busy ? [run] : [],
  };
  let shell = decodeShell({
    ...projection.thread,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    settledOverride: null,
    settledAt: null,
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(BotConnection.BotConnection)({
      current: Effect.succeed({
        url: "https://bot.example",
        grantId: "grant",
        token: "fixture-token-long-enough",
        projectIds: [options.allowed ?? "project"],
        runtimeMode: "approval-required",
      }),
    }),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.succeed([{ ...provider, enabled: !options.unavailable }]),
    }),
    Layer.mock(Adapters.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([provider.instanceId]),
    }),
    Layer.mock(Projects.ProjectStoreV2)({
      list: () =>
        Effect.succeed([
          {
            projectId: projection.thread.projectId,
            title: "Workspace",
            workspaceRoot: "/workspace",
            defaultModelSelection: options.noDefault ? null : projection.thread.modelSelection,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ]),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          const ceiling = yield* DispatchModeLimit;
          assert.equal(ceiling?.runtimeMode, "approval-required");
          launches.push(input);
          return { threadId: projection.thread.id, projection, resumed: launches.length > 1 };
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [shell],
          archivedThreads: [],
        }),
      getThreadSnapshotWindow: (threadId, options) =>
        Effect.sync(() => {
          windowReads.push({ threadId, rowLimit: options.rowLimit });
          return { schemaVersion: 1, snapshotSequence: 0, projection: currentProjection };
        }),
      getProjectThread: (input) =>
        options.missing
          ? Effect.fail(new Threads.ThreadManagementThreadNotFoundError(input))
          : Effect.succeed(currentProjection),
      getThreadProjection: () => Effect.succeed(currentProjection),
      sendToThread: (input) =>
        Effect.sync(() => {
          sends.push(input);
          const message = decodeMessage({
            id: input.messageId,
            nodeId: null,
            streaming: false,
            threadId: input.threadId,
            role: "user",
            text: input.text,
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            createdAt: now,
            updatedAt: now,
            status: "completed",
            runId: run.id,
          });
          currentProjection = { ...currentProjection, runs: [run], messages: [message] };
          return {
            dispatch: { sequence: 1, storedEvents: [] },
            projection: currentProjection,
            message,
            run,
            turnItem: null,
            delivery: "started" as const,
          };
        }),
    }),
    Layer.mock(Environment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("native")),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag === "Uint8Array")
            polls.push(
              JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
            );
          return HttpClientResponse.fromWeb(request, Response.json({ commands: [] }));
        }),
      ),
    ),
  );
  const layer = Bridge.serviceLayer.pipe(
    Layer.provide(dependencies),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        T3BOT_URL: "https://bot.example",
        T3BOT_BRIDGE_ID: "grant".repeat(30),
        T3BOT_BRIDGE_PROJECT_IDS: options.allowed ?? "project",
      }),
    ),
  );
  return {
    layer,
    launches,
    polls,
    sends,
    windowReads,
    setContext: (text: string) => {
      currentProjection = {
        ...currentProjection,
        visibleTurnItems: [{ ...visibleContext, item: { ...context, text } }],
      };
      shell = { ...shell, updatedAt: DateTime.add(shell.updatedAt, { milliseconds: 1 }) };
    },
    run,
    setProjection: (value: typeof currentProjection) => {
      currentProjection = value;
    },
  };
}

it.effect("reconciles launch retries with stable IDs and the destination execution ceiling", () => {
  const h = harness();
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const first = yield* bridge.execute(command);
    yield* bridge.execute(command);
    assert.equal(first.status, "accepted");
    assert.equal(h.launches[0]?.commandId, h.launches[1]?.commandId);
    assert.equal(
      h.launches[0]?.initialMessage?.messageId,
      h.launches[1]?.initialMessage?.messageId,
    );
    assert.ok((h.launches[0]?.commandId.length ?? 0) < 160);
    assert.deepEqual(h.launches[0]?.workspaceStrategy, {
      type: "worktree",
      baseRef: "HEAD",
      startFromOrigin: false,
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "launches a bot-selected custom model with options and plan mode without a project default",
  () => {
    const h = harness({ noDefault: true });
    return Effect.gen(function* () {
      const bridge = yield* Bridge.BotBridge;
      yield* bridge.execute({
        ...command,
        modelSelection: {
          instanceId: provider.instanceId,
          model: "custom-worker",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        interactionMode: "plan",
      });
      assert.deepEqual(h.launches[0]?.modelSelection, {
        instanceId: provider.instanceId,
        model: "custom-worker",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      assert.equal(h.launches[0]?.interactionMode, "plan");
      yield* bridge.tick;
      assert.deepEqual(h.polls[0]?.projects, [{ id: "project", title: "Workspace" }]);
      assert.include(JSON.stringify(h.polls[0]?.providers), "custom-worker");
      assert.include(JSON.stringify(h.polls[0]?.providers), "reasoningEffort");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["model", "option", "disabled"])(
  "rejects a stale or unavailable %s before launch",
  (bad) => {
    const h = harness({ unavailable: bad === "disabled" });
    return Effect.gen(function* () {
      const bridge = yield* Bridge.BotBridge;
      const result = yield* bridge
        .execute({
          ...command,
          modelSelection: {
            instanceId: provider.instanceId,
            model: bad === "model" ? "invented" : "custom-worker",
            options: [{ id: "reasoningEffort", value: bad === "option" ? "invented" : "high" }],
          },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(h.launches.length, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("rejects a project outside the local grant before launching", () => {
  const h = harness({ allowed: "other" });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const result = yield* bridge.execute(command).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(h.launches.length, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("refuses to control an unrelated user thread", () => {
  const h = harness({ userThread: true });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const result = yield* bridge.execute({ ...command, kind: "followup" }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(h.layer));
});

it.effect("reconciles cancellation when a task never reached a persisted executor thread", () => {
  const h = harness({ missing: true });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    assert.equal((yield* bridge.execute({ ...command, kind: "cancel" })).status, "cancelled");
  }).pipe(Effect.provide(h.layer));
});

it.effect("advertises only authorized recent thread context", () => {
  const allowed = harness();
  const denied = harness({ allowed: "other" });
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* (yield* Bridge.BotBridge).tick;
    }).pipe(Effect.provide(allowed.layer));
    yield* Effect.gen(function* () {
      yield* (yield* Bridge.BotBridge).tick;
    }).pipe(Effect.provide(denied.layer));
    assert.equal(
      (allowed.polls[0]?.threads as Array<{ excerpt: string }> | undefined)?.[0]?.excerpt,
      "Recent project context",
    );
    assert.deepEqual(denied.polls[0]?.threads, []);
    assert.deepEqual(denied.windowReads, []);
  });
});

it.effect("refreshes bounded excerpts only when the thread changes", () => {
  const h = harness();
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    yield* bridge.tick;
    yield* bridge.tick;
    assert.deepEqual(h.windowReads, [{ threadId: "task", rowLimit: 8 }]);
    const changed = "x".repeat(2000) + "New context";
    h.setContext(changed);
    yield* bridge.tick;
    assert.equal(h.windowReads.length, 2);
    assert.equal(
      (h.polls[2]?.threads as Array<{ excerpt: string }> | undefined)?.[0]?.excerpt,
      changed.slice(-1600),
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("adopts an idle user thread and reconciles a retry while its own run is busy", () => {
  const h = harness({ userThread: true });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const input = { ...command, kind: "continue" as const, existingThread: true };
    const first = yield* bridge.execute(input);
    const retry = yield* bridge.execute(input);
    assert.equal(first.runId, "run");
    assert.equal(retry.runId, "run");
    assert.equal(h.launches.length, 0);
    assert.equal(h.sends[0]?.messageId, h.sends[1]?.messageId);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each(["starting", "running"] as const)(
  "refuses to adopt a user thread with unrelated %s work",
  (status) => {
    const h = harness({ userThread: true, busy: status });
    return Effect.gen(function* () {
      const bridge = yield* Bridge.BotBridge;
      const result = yield* bridge
        .execute({ ...command, kind: "continue", existingThread: true })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(h.sends.length, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("reports executor command receipts only for completed verification work", () => {
  const h = harness();
  h.setProjection({
    ...projection,
    thread: { ...projection.thread, createdBy: "agent" },
    runs: [{ ...h.run, status: "completed" }],
    turnItems: [
      decodeTurnItem({
        id: "check",
        threadId: "task",
        runId: "run",
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        type: "command_execution",
        status: "completed",
        title: null,
        input: "node --test",
        output: "3 passed",
        exitCode: 0,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      }),
    ],
  });
  return Effect.gen(function* () {
    const bridge = yield* Bridge.BotBridge;
    const report = yield* bridge.execute({
      ...command,
      kind: "inspect",
      runId: "run",
      purpose: "verification",
    });
    assert.equal(report.checks?.length, 1);
    assert.equal(report.checks?.[0]?.command, "node --test");
    assert.equal(report.checks?.[0]?.outcome, "passed");
    assert.deepEqual(
      (yield* bridge.execute({ ...command, kind: "inspect", runId: "run", purpose: "work" }))
        .checks,
      [],
    );
    assert.equal(h.launches.length, 0);
  }).pipe(Effect.provide(h.layer));
});
