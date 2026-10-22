import type * as Jobs from "./Jobs.ts";
import { stableId } from "@t3tools/shared/stableId";
import { serialize } from "./json.ts";
import { BotChatMessage, BotResponsibility } from "@t3tools/contracts/bot";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotError, isBotError } from "./config.ts";
import * as Model from "./Model.ts";
import * as Store from "./Store.ts";
import { GoalWake } from "./Goals.ts";
import { TaskWake } from "./taskWake.ts";
import { toolRunner, silentTool, tools, internalTools } from "./tools.ts";
import {
  coordinatorContext,
  internalAgentPrompt,
  historicalSummary,
  memoryReviewInput,
  messageAcknowledgement,
  summaryInput,
  summaryPrompt,
  timestampedUserMessage,
} from "./prompts.ts";

import * as AgentSessions from "./AgentSessions.ts";
import * as Processes from "./Processes.ts";
import * as Option from "effect/Option";

const Payload = Schema.Struct({
  agentId: Schema.optional(Schema.String),
  text: Schema.String,
  messageId: Schema.optional(Schema.String),
  responsibilityId: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
  taskId: Schema.optional(Schema.String),
  wake: Schema.optional(TaskWake),
  goalId: Schema.optional(Schema.String),
  goalWake: Schema.optional(GoalWake),
});
const Turn = Schema.Struct({
  messages: Schema.fromJsonString(Schema.Array(BotChatMessage)),
  step: Schema.Number,
  tokens: Schema.Number,
});
const Summary = Schema.Struct({ through: Schema.Number, text: Schema.String });

const decodePayload = Schema.decodeEffect(Schema.fromJsonString(Payload));
const decodeResponsibility = Schema.decodeEffect(Schema.fromJsonString(BotResponsibility));
const decodeSummary = Schema.decodeEffect(Schema.fromJsonString(Summary));
const decodeTurn = Schema.decodeEffect(Turn);
const decodeModelStep = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ message: BotChatMessage, tokens: Schema.Number })),
);

export class Coordinator extends Context.Service<
  Coordinator,
  {
    readonly run: (job: Jobs.JobRow) => Effect.Effect<boolean, BotError>;
  }
>()("@t3tools/bot/Coordinator") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.Store;
  const model = yield* Model.Model;
  const invokeTool = yield* toolRunner;
  const agents = yield* AgentSessions.AgentSessions;
  const processes = yield* Effect.serviceOption(Processes.Processes);
  const checkLease = Effect.fn("BotCoordinator.checkLease")(function* (job: Jobs.JobRow) {
    const rows =
      yield* sql`SELECT id FROM jobs WHERE id=${job.id} AND generation=${job.generation} AND state='running'`;
    if (!rows.length) return yield* new BotError({ category: "conflict" });
  });
  const checkResponsibility = Effect.fn("BotCoordinator.checkResponsibility")(function* (
    payload: typeof Payload.Type,
  ) {
    if (!payload.responsibilityId) return true;
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM records WHERE kind='responsibility' AND id=${payload.responsibilityId}`;
    if (!rows[0]) return false;
    const r = yield* decodeResponsibility(rows[0].data);
    return r.state === "active" && r.revision === payload.revision;
  });
  const run = Effect.fn("BotCoordinator.run")(function* (job: Jobs.JobRow) {
    const payload = yield* decodePayload(job.data);
    const active = Effect.gen(function* () {
      if (
        ["agent", "agent_wake"].includes(job.kind) &&
        payload.agentId &&
        (yield* agents.get(payload.agentId)).cancelled
      )
        return false;
      return (
        (yield* checkResponsibility(payload)) &&
        (!payload.wake || (yield* store.isTaskWakeCurrent(payload.wake))) &&
        (!payload.goalWake || (yield* store.isGoalWakeCurrent(payload.goalWake)))
      );
    });
    if (!(yield* active)) return true;
    if (
      job.kind === "responsibility" &&
      payload.responsibilityId &&
      payload.revision !== undefined
    ) {
      yield* store.command(
        { type: "responsibility.run", requestId: job.id, id: payload.responsibilityId },
        undefined,
        { responsibilityId: payload.responsibilityId, revision: payload.revision },
        job.id,
      );
      return true;
    }
    const snapshot = yield* store.snapshot();
    const internal =
      job.kind === "agent" && payload.agentId ? yield* agents.get(payload.agentId) : null;
    const systemPrompt = (now: number) =>
      internal
        ? internalAgentPrompt(internal, now)
        : coordinatorContext(snapshot, now, payload.goalWake?.goalId);
    if (job.kind === "memory_review" && !snapshot.autoMemory) return true;
    if (job.kind === "summary") {
      const epochRows = yield* sql<{
        seq: number;
      }>`SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE kind LIKE 'memory.%'`;
      const epoch = epochRows[0]?.seq ?? 0;
      const previousRows = yield* sql<{
        data: string;
      }>`SELECT data FROM records WHERE kind='summary' AND id='main'`;
      const previousSummary = previousRows[0] ? yield* decodeSummary(previousRows[0].data) : null;
      if (previousSummary && previousSummary.through >= Number(payload.messageId)) return true;
      const summaryResponse = yield* model.complete(
        snapshot.provider,
        [
          {
            role: "system",
            content: summaryPrompt,
          },
          {
            role: "user",
            content: summaryInput(previousSummary?.text ?? "", payload.text),
          },
        ],
        [],
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* checkLease(job);
          const currentEpoch = yield* sql<{
            seq: number;
          }>`SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE kind LIKE 'memory.%'`;
          if ((currentEpoch[0]?.seq ?? 0) !== epoch) return;
          const through = Number(payload.messageId);
          const previous = yield* sql<{
            data: string;
          }>`SELECT data FROM records WHERE kind='summary' AND id='main'`;
          const old = previous[0] ? yield* decodeSummary(previous[0].data) : null;
          if (old && old.through >= through) return;
          yield* sql`INSERT INTO records(kind,id,revision,data) VALUES('summary','main',0,${serialize({ through, text: summaryResponse.message.content?.slice(0, 12000) ?? "" })}) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`;
        }),
      );
      return true;
    }
    let row = (yield* sql<{
      messages: string;
      step: number;
      tokens: number;
    }>`SELECT messages,step,tokens FROM turns WHERE id=${job.id}`)[0];
    if (!row) {
      const now = yield* Clock.currentTimeMillis;
      const summaries = yield* sql<{
        data: string;
      }>`SELECT data FROM records WHERE kind='summary' AND id='main'`;
      const summary = summaries[0] ? yield* decodeSummary(summaries[0].data) : null;
      const messages: Array<BotChatMessage> = [{ role: "system", content: systemPrompt(now) }];
      if (summary && !internal)
        messages.push({
          role: "system",
          content: historicalSummary(summary.text),
        });
      const sources = payload.messageId
        ? yield* sql<{
            seq: number;
            createdAt: number;
          }>`SELECT seq,created_at AS createdAt FROM messages WHERE id=${payload.messageId}`
        : [];
      const history = yield* sql<{
        seq: number;
        role: "user" | "assistant" | "system";
        text: string;
      }>`SELECT seq,role,text FROM messages WHERE seq <= ${sources[0]?.seq ?? Number.MAX_SAFE_INTEGER} AND seq > ${summary?.through ?? 0} AND NOT (role='system' AND text=${messageAcknowledgement}) ORDER BY seq DESC LIMIT 35`;
      let remaining = 36000;
      const recent: Array<BotChatMessage> = [];
      for (const message of history) {
        if (remaining <= 0) break;
        const text =
          sources[0]?.seq === message.seq
            ? timestampedUserMessage(message.text, sources[0].createdAt)
            : message.text;
        const content = text.slice(0, remaining);
        recent.push({ role: message.role === "system" ? "user" : message.role, content });
        remaining -= content.length;
      }
      if (!internal) messages.push(...recent.toReversed());
      if (!payload.messageId || job.kind === "memory_review")
        messages.push({ role: "user", content: payload.text });
      row = { messages: serialize(messages), step: 0, tokens: 0 };
      yield* sql`INSERT OR IGNORE INTO turns(id,messages) VALUES(${job.id},${row.messages})`;
    }
    const turn = yield* decodeTurn(row);
    if (turn.step >= 12 || turn.tokens >= 96000) return yield* new BotError({ category: "budget" });
    const stepId = `${job.id}:${turn.step}`;
    const saved = yield* sql<{ data: string }>`SELECT data FROM model_steps WHERE id=${stepId}`;
    let response: { message: BotChatMessage; tokens: number };
    if (saved[0]) response = yield* decodeModelStep(saved[0].data);
    else {
      const reservation = Math.ceil(serialize(turn.messages).length / 3) + 4096;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* checkLease(job);
          const reserved =
            yield* sql`UPDATE turns SET tokens=tokens+${reservation} WHERE id=${job.id} AND tokens+${reservation}<=96000 RETURNING id`;
          if (!reserved.length) return yield* new BotError({ category: "budget" });
        }),
      );
      const currentTime = yield* Clock.currentTimeMillis;
      response = yield* model.complete(
        snapshot.provider,
        turn.messages.map((message, index) =>
          index === 0 && message.role === "system"
            ? {
                ...message,
                content: systemPrompt(currentTime),
              }
            : message,
        ),
        internal
          ? internalTools
          : job.kind === "memory_review"
            ? tools.filter((t) => t.function.name === "remember")
            : ["task_wake", "goal_wake", "agent_wake", "process_wake"].includes(job.kind)
              ? [...tools, silentTool]
              : tools,
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* checkLease(job);
          yield* sql`INSERT OR IGNORE INTO model_steps(id,data) VALUES(${stepId},${serialize(response)})`;
        }),
      );
    }
    const silent =
      response.message.tool_calls?.some((call) => call.function.name === "complete_silently") ??
      false;
    if (
      silent &&
      (!["task_wake", "goal_wake", "agent_wake", "process_wake"].includes(job.kind) ||
        response.message.tool_calls?.length !== 1)
    )
      return yield* new BotError({ category: "invalid" });
    const next = [...turn.messages, response.message];
    if (
      internal &&
      response.message.tool_calls?.some(
        (call) => !internalTools.some((tool) => tool.function.name === call.function.name),
      )
    )
      return yield* new BotError({ category: "unauthorized" });
    for (const [index, call] of (response.message.tool_calls ?? []).entries()) {
      yield* checkLease(job);
      if (!(yield* active)) return true;
      if (job.kind === "memory_review" && call.function.name !== "remember")
        return yield* new BotError({ category: "unauthorized" });
      const requestId = `tool:${stepId}:${index}`;
      const invoke = invokeTool(call, {
        job,
        requestId,
        messageId: payload.messageId,
        agentId: payload.agentId,
        responsibilityId: payload.responsibilityId,
        goalId: payload.goalWake?.goalId,
        commit: (decoded) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* checkLease(job);
              if (!(yield* active)) return yield* new BotError({ category: "conflict" });
              return yield* store.command(
                decoded,
                undefined,
                payload.responsibilityId && payload.revision !== undefined
                  ? { responsibilityId: payload.responsibilityId, revision: payload.revision }
                  : undefined,
                job.id,
                payload.goalWake,
              );
            }),
          ),
      });
      const result = yield* invoke.pipe(
        Effect.catch((cause) =>
          Effect.succeed({ error: isBotError(cause) ? cause.category : "invalid_arguments" }),
        ),
      );
      next.push({
        role: "tool",
        tool_call_id: call.id,
        content: serialize(result).slice(0, 30000),
      });
    }
    if (!(yield* active)) return true;
    const done = silent || !response.message.tool_calls?.length;
    if (done && internal && Option.isSome(processes)) yield* processes.value.cancelOwner(job.id);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* checkLease(job);
        if (!(yield* active)) return;
        if (done && internal) yield* agents.complete(internal.id, response.message.content ?? "");
        if (done && !silent && job.kind !== "memory_review" && !internal)
          yield* store.append(
            `answer:${job.id}`,
            "assistant",
            response.message.content ?? "",
            job.id,
          );
        yield* sql`UPDATE turns SET messages=${serialize(next)},step=step+1 WHERE id=${job.id}`;
        if (done) {
          yield* sql`UPDATE jobs SET state='done',lease_until=NULL WHERE id=${job.id} AND generation=${job.generation}`;
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO events(kind,created_at) VALUES('jobs',${now})`;
        }
        if (!done)
          yield* sql`UPDATE jobs SET state='pending',lease_until=NULL,attempts=0 WHERE id=${job.id} AND generation=${job.generation}`;
        if (done && job.kind === "turn" && payload.messageId) {
          const now = yield* Clock.currentTimeMillis;
          if ((yield* store.settings).autoMemory)
            yield* sql`INSERT OR IGNORE INTO jobs(id,kind,data,due_at) VALUES(${stableId("review", payload.messageId)},'memory_review',${serialize({ text: memoryReviewInput(payload.text, response.message.content ?? ""), messageId: payload.messageId })},${now + 1000})`;
          const previousRows = yield* sql<{
            data: string;
          }>`SELECT data FROM records WHERE kind='summary' AND id='main'`;
          const previous = previousRows[0] ? yield* decodeSummary(previousRows[0].data) : null;
          const tail = yield* sql<{
            seq: number;
          }>`SELECT COALESCE(MAX(seq),0) AS seq FROM messages`;
          const forgotten = yield* sql<{
            source: string;
          }>`SELECT json_extract(data,'$.source') AS source FROM records WHERE kind='memory' AND json_extract(data,'$.deleted')=1`;
          const hidden = new Set(forgotten.map((m) => m.source));
          const candidates = yield* sql<{
            seq: number;
            id: string;
            role: string;
            text: string;
          }>`SELECT seq,id,role,text FROM messages WHERE seq>${previous?.through ?? 0} AND seq<=${(tail[0]?.seq ?? 0) - 35} ORDER BY seq LIMIT 30`;
          let bytes = 0;
          const old = candidates.filter((m, index) => {
            bytes += m.text.length;
            return !hidden.has(m.id) && (index === 0 || bytes <= 36000);
          });
          const through = old.at(-1)?.seq;
          const memoryEpoch = yield* sql<{
            seq: number;
          }>`SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE kind LIKE 'memory.%'`;
          if (through)
            yield* sql`INSERT OR IGNORE INTO jobs(id,kind,data,due_at) VALUES(${stableId("summary", through, memoryEpoch[0]?.seq ?? 0)},'summary',${serialize({ text: old.map((m) => `${m.role}: ${m.text}`).join("\n"), messageId: String(through) })},${now + 1000})`;
        }
      }),
    );
    return done;
  });
  return Coordinator.of({
    run: (job) =>
      run(job).pipe(
        Effect.mapError((cause) =>
          isBotError(cause) ? cause : new BotError({ category: "storage", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(Coordinator, make).pipe(Layer.provideMerge(AgentSessions.layer));
