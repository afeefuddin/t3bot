import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderOptionDescriptor, ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const BOT_PROTOCOL_VERSION = 1;

export const BotBridgeConnectionConfig = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)),
  grantId: Id,
  token: Schema.String.check(Schema.isMinLength(24)),
  projectIds: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  runtimeMode: RuntimeMode,
});
export type BotBridgeConnectionConfig = typeof BotBridgeConnectionConfig.Type;
export const BotBridgeConnectionInput = Schema.Struct({
  ...BotBridgeConnectionConfig.fields,
  token: Schema.optionalKey(Schema.String.check(Schema.isMinLength(24))),
});
export type BotBridgeConnectionInput = typeof BotBridgeConnectionInput.Type;
export const BotBridgeConnectionStatus = Schema.NullOr(
  Schema.Struct({
    url: Schema.String,
    grantId: Id,
    projectIds: Schema.Array(Id),
    runtimeMode: RuntimeMode,
  }),
);
export class BotConnectionError extends Schema.TaggedError<BotConnectionError>()(
  "BotConnectionError",
  {
    category: Schema.Literals(["configuration", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Bot connection failed (${this.category}).`;
  }
}

export const BotAvatar = Schema.Struct({
  shape: Schema.Literals(["rounded", "square", "circle"]),
  eyes: Schema.Literals(["dots", "visor", "happy"]),
  mouth: Schema.Literals(["smile", "flat", "grille"]),
  color: Schema.Literals(["blue", "moss", "amber", "rose", "graphite"]),
  antenna: Schema.Boolean,
});
export type BotAvatar = typeof BotAvatar.Type;
export const DEFAULT_BOT_AVATAR: BotAvatar = {
  shape: "rounded",
  eyes: "dots",
  mouth: "smile",
  color: "blue",
  antenna: true,
};

export const BotSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), at: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(60000)),
  }),
  Schema.Struct({
    type: Schema.Literal("daily"),
    time: Schema.String,
    timezone: Schema.String,
    weekdays: Schema.Array(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    event: Schema.Literals(["task_completed", "environment_connected"]),
  }),
]);
export type BotSchedule = typeof BotSchedule.Type;

export const BOT_MAX_VERIFICATION_CHECKS = 32;
export const BotVerificationCheck = Schema.Struct({
  id: Id,
  runId: Id,
  command: Schema.String.check(Schema.isMaxLength(2048)),
  output: Schema.String.check(Schema.isMaxLength(1500)),
  exitCode: Schema.NullOr(Schema.Int),
  outcome: Schema.Literals(["passed", "failed", "unknown"]),
});
export type BotVerificationCheck = typeof BotVerificationCheck.Type;
const VerificationChecks = Schema.Array(BotVerificationCheck).check(
  Schema.isMaxLength(BOT_MAX_VERIFICATION_CHECKS),
);

export const BotGoalEvidence = Schema.Struct({
  criterion: Revision,
  taskId: Id,
  generation: Revision,
  runId: Id,
  quote: Text,
  checkIds: Schema.optionalKey(
    Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(BOT_MAX_VERIFICATION_CHECKS)),
  ),
});
export const BotGoal = Schema.Struct({
  id: Id,
  revision: Revision,
  generation: Revision,
  title: Title,
  objective: Text,
  criteria: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  environmentId: Id,
  projectId: Id,
  state: Schema.Literals(["active", "verifying", "blocked", "paused", "completed", "cancelled"]),
  reason: Schema.String,
  evidence: Schema.Array(BotGoalEvidence),
  rounds: Revision,
  roundLimit: Schema.optionalKey(Revision),
  nextAt: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
});
export type BotGoal = typeof BotGoal.Type;

export const BotCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("goal.create"),
    requestId: Id,
    id: Id,
    title: Title,
    objective: Text,
    criteria: BotGoal.fields.criteria,
    environmentId: Id,
    projectId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("goal.state"),
    requestId: Id,
    id: Id,
    revision: Revision,
    state: Schema.Literals(["active", "blocked", "paused", "cancelled"]),
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("goal.verify"),
    requestId: Id,
    id: Id,
    revision: Revision,
    taskId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("goal.complete"),
    requestId: Id,
    id: Id,
    revision: Revision,
    summary: Text,
    evidence: Schema.Array(BotGoalEvidence).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  }),
  Schema.Struct({
    type: Schema.Literal("avatar.save"),
    requestId: Id,
    avatar: Schema.NullOr(BotAvatar),
  }),
  Schema.Struct({
    type: Schema.Literal("conversation.read"),
    requestId: Id,
    through: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("message"), requestId: Id, text: Text }),
  Schema.Struct({
    type: Schema.Literal("memory.save"),
    requestId: Id,
    id: Id,
    revision: Revision,
    scope: Id,
    text: Text,
    source: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("memory.forget"),
    requestId: Id,
    id: Id,
    revision: Revision,
  }),
  Schema.Struct({
    type: Schema.Literal("responsibility.save"),
    requestId: Id,
    id: Id,
    revision: Revision,
    title: Title,
    instructions: Text,
    environmentId: Schema.NullOr(Id),
    projectId: Schema.NullOr(Id),
    schedule: BotSchedule,
  }),
  Schema.Struct({
    type: Schema.Literal("responsibility.state"),
    requestId: Id,
    id: Id,
    revision: Revision,
    state: Schema.Literals(["active", "paused", "archived"]),
  }),
  Schema.Struct({ type: Schema.Literal("responsibility.run"), requestId: Id, id: Id }),
  Schema.Struct({
    type: Schema.Literal("task.start"),
    goalId: Schema.optionalKey(Id),
    threadId: Schema.optionalKey(Id),
    requestId: Id,
    title: Title,
    instructions: Text,
    environmentId: Id,
    projectId: Id,
    isolated: Schema.Boolean,
    modelSelection: Schema.optionalKey(ModelSelection),
    interactionMode: Schema.optionalKey(ProviderInteractionMode),
  }),
  Schema.Struct({
    type: Schema.Literal("task.watch"),
    requestId: Id,
    id: Id,
    afterMs: Schema.NullOr(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 60000, maximum: 86400000 })),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("task.followup"), requestId: Id, id: Id, text: Text }),
  Schema.Struct({ type: Schema.Literal("task.cancel"), requestId: Id, id: Id }),
  Schema.Struct({ type: Schema.Literal("environment.create"), requestId: Id, name: Title }),
  Schema.Struct({ type: Schema.Literal("environment.revoke"), requestId: Id, id: Id }),
  Schema.Struct({ type: Schema.Literal("job.retry"), requestId: Id, id: Id }),
  Schema.Struct({
    type: Schema.Literal("connector.state"),
    requestId: Id,
    id: Id,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("settings"),
    requestId: Id,
    provider: Id,
    autoMemory: Schema.Boolean,
  }),
]);
export type BotCommand = typeof BotCommand.Type;

export const BotMessage = Schema.Struct({
  seq: Schema.Number,
  id: Id,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  createdAt: Schema.Number,
});
export type BotMessage = typeof BotMessage.Type;
export const BotMemory = Schema.Struct({
  id: Id,
  revision: Revision,
  scope: Id,
  text: Schema.String,
  source: Schema.String,
  deleted: Schema.Boolean,
  updatedAt: Schema.Number,
});
export type BotMemory = typeof BotMemory.Type;
export const BotResponsibility = Schema.Struct({
  id: Id,
  revision: Revision,
  title: Title,
  instructions: Text,
  environmentId: Schema.NullOr(Id),
  projectId: Schema.NullOr(Id),
  schedule: BotSchedule,
  state: Schema.Literals(["active", "paused", "archived"]),
  nextAt: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
});
export type BotResponsibility = typeof BotResponsibility.Type;
export const BotTaskStatus = Schema.Literals([
  "queued",
  "waiting_environment",
  "accepted",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancellation_requested",
  "cancelled",
]);
export const BotTask = Schema.Struct({
  existingThread: Schema.optionalKey(Schema.Boolean),
  goalId: Schema.optionalKey(Id),
  purpose: Schema.optionalKey(Schema.Literals(["work", "verification"])),
  checks: Schema.optionalKey(VerificationChecks),
  id: Id,
  title: Title,
  instructions: Text,
  environmentId: Id,
  projectId: Id,
  generation: Schema.Number,
  responsibilityId: Schema.NullOr(Id),
  responsibilityRevision: Schema.NullOr(Schema.Number),
  threadId: Schema.NullOr(Id),
  runId: Schema.NullOr(Id),
  status: BotTaskStatus,
  result: Schema.String,
  updatedAt: Schema.Number,
  modelSelection: Schema.optionalKey(ModelSelection),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type BotTask = typeof BotTask.Type;
export const BotThreadContext = Schema.Struct({
  isolated: Schema.optionalKey(Schema.Boolean),
  id: Id,
  projectId: Id,
  title: Schema.String,
  status: Schema.String,
  updatedAt: Schema.Number,
  modelSelection: ModelSelection,
  excerpt: Schema.String.check(Schema.isMaxLength(1600)),
});
export type BotThreadContext = typeof BotThreadContext.Type;
export const BotProject = Schema.Struct({
  id: Id,
  title: Schema.String,
  instanceId: Schema.optionalKey(Id),
  model: Schema.optionalKey(Id),
  options: Schema.optionalKey(ProviderOptionSelections),
});
export const BotWorkerProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  name: Schema.String,
  interactionModes: Schema.Array(ProviderInteractionMode),
  models: Schema.Array(
    Schema.Struct({ id: Id, name: Schema.String, options: Schema.Array(ProviderOptionDescriptor) }),
  ),
});
export type BotWorkerProvider = typeof BotWorkerProvider.Type;
export const BotEnvironment = Schema.Struct({
  id: Id,
  name: Title,
  identity: Schema.NullOr(Id),
  revoked: Schema.Boolean,
  lastSeen: Schema.Number,
  projects: Schema.Array(BotProject),
  threads: Schema.optionalKey(Schema.Array(BotThreadContext).check(Schema.isMaxLength(30))),
  providers: Schema.optionalKey(Schema.Array(BotWorkerProvider)),
});
export type BotEnvironment = typeof BotEnvironment.Type;
export const BotJob = Schema.Struct({
  id: Id,
  kind: Schema.String,
  state: Schema.Literals(["pending", "running", "done", "failed"]),
  attempts: Schema.Number,
  dueAt: Schema.Number,
  error: Schema.NullOr(Schema.String),
});
export type BotJob = typeof BotJob.Type;
export const BotConnector = Schema.Struct({
  id: Id,
  name: Title,
  type: Schema.Literals(["slack", "telegram"]),
  enabled: Schema.Boolean,
  pending: Schema.Number,
  failed: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
});
export type BotConnector = typeof BotConnector.Type;
export const BotSnapshot = Schema.Struct({
  protocol: Schema.Literal(1),
  cursor: Schema.Number,
  readThrough: Schema.Number,
  unread: Schema.Number,
  messages: Schema.Array(BotMessage),
  memories: Schema.Array(BotMemory),
  responsibilities: Schema.Array(BotResponsibility),
  tasks: Schema.Array(BotTask),
  goals: Schema.optionalKey(Schema.Array(BotGoal)),
  environments: Schema.Array(BotEnvironment),
  jobs: Schema.Array(BotJob),
  providers: Schema.Array(Id),
  provider: Schema.String,
  autoMemory: Schema.Boolean,
  connectors: Schema.optionalKey(Schema.Array(BotConnector)),
  avatar: Schema.optionalKey(BotAvatar),
});
export type BotSnapshot = typeof BotSnapshot.Type;

export const BotBridgeCommand = Schema.Struct({
  purpose: BotTask.fields.purpose,
  existingThread: Schema.optionalKey(Schema.Boolean),
  id: Id,
  taskId: Id,
  generation: Schema.Number,
  kind: Schema.Literals(["start", "continue", "followup", "cancel", "inspect"]),
  projectId: Id,
  threadId: Id,
  runId: Schema.NullOr(Id),
  text: Schema.String,
  title: Schema.String,
  isolated: Schema.Boolean,
  modelSelection: Schema.optionalKey(ModelSelection),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type BotBridgeCommand = typeof BotBridgeCommand.Type;
export const BotBridgePoll = Schema.Struct({
  protocol: Schema.Literal(1),
  identity: Id,
  projects: Schema.Array(BotProject),
  threads: Schema.optionalKey(Schema.Array(BotThreadContext).check(Schema.isMaxLength(30))),
  providers: Schema.optionalKey(Schema.Array(BotWorkerProvider)),
});
export const BotBridgeReport = Schema.Struct({
  checks: Schema.optionalKey(VerificationChecks),
  retryable: Schema.optionalKey(Schema.Boolean),
  commandId: Id,
  taskId: Id,
  threadId: Id,
  runId: Schema.NullOr(Id),
  status: BotTaskStatus,
  result: Schema.String,
});
export type BotBridgeReport = typeof BotBridgeReport.Type;
export const BotBridgePollResult = Schema.Struct({ commands: Schema.Array(BotBridgeCommand) });

export const BotChatMessage = Schema.Struct({
  // Opaque model continuation data must survive durable tool steps and process restarts.
  responseState: Schema.optional(
    Schema.Struct({
      issuer: Schema.String,
      output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_call_id: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        type: Schema.Literal("function"),
        function: Schema.Struct({ name: Id, arguments: Schema.String }),
      }),
    ),
  ),
});
export type BotChatMessage = typeof BotChatMessage.Type;
export const BotModelResponse = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: BotChatMessage })),
  usage: Schema.optional(Schema.Struct({ total_tokens: Schema.Number })),
});
