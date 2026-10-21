import { RunId } from "@t3tools/contracts";
import * as BotConnection from "./BotConnection.ts";
import { stableId } from "@t3tools/shared/stableId";
import { isBotWorkerSelectionAvailable } from "@t3tools/shared/botWorkers";
import { summarizeBotRun } from "./projection.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import {
  BotBridgeCommand,
  BotBridgePollResult,
  type BotBridgeReport,
  type BotWorkerProvider,
  type BotBridgeConnectionConfig,
} from "@t3tools/contracts/bot";
import { CommandId, MessageId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { forkParked } from "../serverActivation.ts";

export class BotBridgeError extends Schema.TaggedError<BotBridgeError>()("BotBridgeError", {
  category: Schema.Literals(["configuration", "scope", "transport", "execution"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Bot bridge failed (${this.category}).`;
  }
}

export class BotBridge extends Context.Service<
  BotBridge,
  {
    readonly execute: (command: BotBridgeCommand) => Effect.Effect<BotBridgeReport, BotBridgeError>;
    readonly tick: Effect.Effect<void, BotBridgeError>;
  }
>()("t3/bot/BotBridge") {}

const decodePoll = Schema.decodeUnknownEffect(BotBridgePollResult);
const isBotBridgeError = Schema.is(BotBridgeError);
const make = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  const connections = yield* BotConnection.BotConnection;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identity = yield* ServerEnvironment.ServerEnvironment;
  const http = yield* HttpClient.HttpClient;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapters.ProviderAdapterRegistryV2;
  const workerProviders = Effect.gen(function* () {
    const registered = new Set(yield* adapters.list());
    return (yield* registry.getProviders)
      .filter(
        (p) =>
          registered.has(p.instanceId) &&
          p.enabled &&
          p.installed &&
          p.availability !== "unavailable" &&
          p.status !== "error" &&
          p.status !== "disabled" &&
          p.auth.status !== "unauthenticated",
      )
      .map((p): BotWorkerProvider => ({
        instanceId: p.instanceId,
        driver: p.driver,
        name: p.displayName ?? p.instanceId,
        interactionModes: p.showInteractionModeToggle ? ["default", "plan"] : ["default"],
        models: p.models.map((model) => ({
          id: model.slug,
          name: model.name ?? model.slug,
          options: model.capabilities?.optionDescriptors ?? [],
        })),
      }));
  });
  const modelFor = (project: {
    defaultModelSelection: { instanceId: ProviderInstanceId; model: string } | null;
  }) =>
    project.defaultModelSelection ??
    (env.T3BOT_BRIDGE_INSTANCE_ID && env.T3BOT_BRIDGE_MODEL
      ? {
          instanceId: ProviderInstanceId.make(env.T3BOT_BRIDGE_INSTANCE_ID),
          model: env.T3BOT_BRIDGE_MODEL,
        }
      : null);
  const rank = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };
  const execute = Effect.fn("BotBridge.execute")(function* (
    command: BotBridgeCommand,
    connection: BotBridgeConnectionConfig,
  ) {
    const allowed = new Set(connection.projectIds);
    const grant = connection.grantId;
    const mode = connection.runtimeMode;
    if (!allowed.has("*") && !allowed.has(command.projectId))
      return yield* new BotBridgeError({ category: "scope" });
    const catalog = yield* projects.list();
    const project = catalog.find((p) => p.projectId === command.projectId && p.deletedAt === null);
    if (!project) return yield* new BotBridgeError({ category: "scope" });
    const threadId = ThreadId.make(command.threadId);
    const commandId = CommandId.make(stableId("bot", grant, command.id));
    const messageId = MessageId.make(stableId("bot-message", grant, command.id));
    if (command.kind === "start") {
      const selection = command.modelSelection ?? modelFor(project);
      const interactionMode = command.interactionMode ?? "default";
      if (
        !selection ||
        !isBotWorkerSelectionAvailable(yield* workerProviders, selection, interactionMode)
      )
        return yield* new BotBridgeError({ category: "configuration" });
      // The explicit thread and command IDs make a lost bridge acknowledgement safe to reconcile.
      yield* launch.launch({
        commandId,
        threadId,
        projectId: project.projectId,
        title: command.title,
        modelSelection: selection,
        runtimeMode: mode,
        interactionMode,
        workspaceStrategy: command.isolated
          ? { type: "worktree", baseRef: "HEAD", startFromOrigin: false }
          : { type: "root" },
        initialMessage: { messageId, text: command.text, attachments: [] },
        createdBy: "agent",
        creationSource: "server",
      });
    }
    let projection = yield* threads
      .getProjectThread({ projectId: project.projectId, threadId })
      .pipe(Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.succeed(null) }));
    if (!projection)
      return {
        commandId: command.id,
        taskId: command.taskId,
        threadId: command.threadId,
        runId: null,
        status: command.kind === "cancel" ? "cancelled" : "failed",
        result: "The executor has no persisted thread for this task.",
      } satisfies BotBridgeReport;
    if (
      projection.thread.projectId !== project.projectId ||
      (!command.existingThread &&
        (projection.thread.createdBy !== "agent" ||
          projection.thread.creationSource !== "server")) ||
      rank[projection.thread.runtimeMode] > rank[mode]
    )
      return yield* new BotBridgeError({ category: "scope" });
    if (
      command.kind === "continue" &&
      !projection.messages.some((message) => message.id === messageId) &&
      projection.runs.some((run) =>
        ["preparing", "starting", "running", "waiting", "queued"].includes(run.status),
      )
    )
      return yield* new BotBridgeError({ category: "scope" });
    if (command.kind === "followup" || command.kind === "continue") {
      const sent = yield* threads.sendToThread({
        projectId: project.projectId,
        commandId,
        threadId,
        messageId,
        text: command.text,
        attachments: [],
        mode: "queue",
        ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
        createdBy: "agent",
        creationSource: "server",
      });
      projection = yield* threads.getThreadProjection(threadId);
      return {
        commandId: command.id,
        taskId: command.taskId,
        threadId: command.threadId,
        ...summarizeBotRun(projection, sent.run.id, command.purpose === "verification"),
      };
    } else if (command.kind === "cancel") {
      if (command.existingThread && !command.runId)
        return yield* new BotBridgeError({ category: "scope" });
      for (const run of projection.runs.filter(
        (run) => run.status === "queued" && (!command.runId || run.id === command.runId),
      )) {
        yield* threads.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(stableId("bot-cancel", commandId, run.id)),
          threadId,
          runId: run.id,
        });
      }
      yield* threads.interruptThread({
        projectId: project.projectId,
        commandId,
        threadId,
        ...(command.runId ? { runId: RunId.make(command.runId) } : {}),
        reason: "Cancelled by t3bot owner",
      });
      projection = yield* threads.getThreadProjection(threadId);
    }
    const active = projection.runs.find((run) =>
      ["preparing", "starting", "running", "waiting", "queued"].includes(run.status),
    );
    return {
      commandId: command.id,
      taskId: command.taskId,
      threadId: command.threadId,
      ...summarizeBotRun(
        projection,
        command.kind === "cancel" ? (command.runId ?? active?.id ?? null) : command.runId,
        command.purpose === "verification",
      ),
    };
  });
  const send = (connection: BotBridgeConnectionConfig, path: string, body: unknown) =>
    http
      .execute(
        HttpClientRequest.post(
          `${connection.url}/bridge/${encodeURIComponent(connection.grantId)}/${path}`,
        ).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${connection.token}`),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200)
              return yield* new BotBridgeError({ category: "transport" });
            return yield* response.json;
          }),
        ),
        Effect.timeout("20 seconds"),
        Effect.mapError((cause) =>
          isBotBridgeError(cause) ? cause : new BotBridgeError({ category: "transport", cause }),
        ),
      );
  const excerpts = new Map<string, { updatedAt: number; text: string }>();
  const tick = Effect.gen(function* () {
    const connection = yield* connections.current;
    if (!connection) return;
    const allowed = new Set(connection.projectIds);
    const mode = connection.runtimeMode;
    const projectList = (yield* projects.list()).filter(
      (p) => p.deletedAt === null && (allowed.has("*") || allowed.has(p.projectId)),
    );
    const authorizedProjects = new Set(projectList.map((p) => p.projectId));
    const recentThreads = (yield* threads.getShellSnapshot({ location: "active" })).threads
      .filter(
        (thread) =>
          authorizedProjects.has(thread.projectId) &&
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          thread.lineage.relationshipToParent !== "subagent",
      )
      .toSorted((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
      .slice(0, 30);
    const visible = new Set<string>(recentThreads.map((thread) => thread.id));
    for (const id of excerpts.keys()) if (!visible.has(id)) excerpts.delete(id);
    const threadContext = yield* Effect.forEach(
      recentThreads,
      (thread) =>
        Effect.gen(function* () {
          const updatedAt = DateTime.toEpochMillis(thread.updatedAt);
          let excerpt = excerpts.get(thread.id);
          if (!excerpt || excerpt.updatedAt !== updatedAt) {
            // Shell snapshots omit message text. Read a bounded window only when context changes.
            const text = yield* threads.getThreadSnapshotWindow(thread.id, { rowLimit: 8 }).pipe(
              Effect.map(
                ({ projection }) =>
                  projection.visibleTurnItems
                    .map(({ item }) => item)
                    .filter(
                      (item) => item.type === "assistant_message" || item.type === "user_message",
                    )
                    .findLast((item) => item.text.trim())
                    ?.text.slice(-1600) ?? "",
              ),
              Effect.tap((text) =>
                Effect.sync(() => {
                  excerpts.set(thread.id, { updatedAt, text });
                }),
              ),
              Effect.catch(() => Effect.succeed("")),
            );
            excerpt = { updatedAt, text };
          }
          return {
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            status: thread.status,
            updatedAt,
            modelSelection: thread.modelSelection,
            isolated: thread.worktreePath !== null,
            excerpt: excerpt.text,
          };
        }),
      { concurrency: 4 },
    );
    const poll = yield* send(connection, "poll", {
      protocol: 1,
      identity: yield* identity.getEnvironmentId,
      projects: projectList.map((p) => ({
        id: p.projectId,
        title: p.title,
        ...modelFor(p),
      })),
      providers: yield* workerProviders,
      threads: threadContext,
    }).pipe(Effect.flatMap(decodePoll));
    yield* Effect.forEach(
      poll.commands,
      (command) =>
        execute(command, connection).pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: mode,
            interactionMode: "default",
          }),
          Effect.flatMap((report) => send(connection, "report", report)),
          // Keep uncertain transport/execution outcomes pending: the next delivery reconciles the same command.
          Effect.catch((cause) =>
            isBotBridgeError(cause) &&
            (cause.category === "configuration" || cause.category === "scope")
              ? send(connection, "report", {
                  commandId: command.id,
                  taskId: command.taskId,
                  threadId: command.threadId,
                  runId: command.runId,
                  status: "waiting_input",
                  result:
                    "The executor needs its project grant, provider/model configuration, or execution mode corrected before this task can proceed.",
                  retryable: true,
                }).pipe(Effect.catch(() => Effect.void))
              : Effect.logWarning("Bot bridge command is pending reconciliation", {
                  commandId: command.id,
                  category: isBotBridgeError(cause) ? cause.category : "execution",
                }),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  });
  const wrap = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotBridgeError(cause) ? cause : new BotBridgeError({ category: "execution", cause }),
      ),
    );
  return BotBridge.of({
    execute: (command) =>
      wrap(
        Effect.gen(function* () {
          const connection = yield* connections.current;
          if (!connection) return yield* new BotBridgeError({ category: "configuration" });
          return yield* execute(command, connection).pipe(
            Effect.provideService(DispatchModeLimit, {
              runtimeMode: connection.runtimeMode,
              interactionMode: "default",
            }),
          );
        }),
      ),
    tick: wrap(tick),
  });
});

export const serviceLayer = Layer.effect(BotBridge, make);
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bridge = yield* BotBridge;
    yield* forkParked(
      bridge.tick.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Bot bridge reconnect pending", { category: cause.category }),
        ),
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.forever,
      ),
    );
  }),
).pipe(Layer.provide(serviceLayer));
