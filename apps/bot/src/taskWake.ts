import * as Schema from "effect/Schema";

export const TaskWake = Schema.Struct({
  taskId: Schema.String,
  generation: Schema.Number,
  revision: Schema.Number,
  reason: Schema.Literals([
    "blocked",
    "stalled",
    "offline",
    "reconnected",
    "completed",
    "failed",
    "cancelled",
  ]),
});
export type TaskWake = typeof TaskWake.Type;

export const TaskWatch = Schema.Struct({
  generation: Schema.Number,
  revision: Schema.Number,
  sequence: Schema.Number,
  enabled: Schema.optionalKey(Schema.Boolean),
  progressAt: Schema.Number,
  nextAt: Schema.NullOr(Schema.Number),
  intervalMs: Schema.Number,
});
export type TaskWatch = typeof TaskWatch.Type;
export const DEFAULT_TASK_CHECK_MS = 300000;
