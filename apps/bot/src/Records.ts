import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotError, isBotError } from "./config.ts";
import { serialize } from "./json.ts";
import type { BotMessage } from "@t3tools/contracts/bot";
import { stableId } from "@t3tools/shared/stableId";
import * as DeliveryStore from "./DeliveryStore.ts";

export class Records extends Context.Service<
  Records,
  {
    readonly read: <A>(
      kind: string,
      id: string,
      schema: Schema.Codec<A, unknown>,
    ) => Effect.Effect<A | null, BotError>;
    readonly list: <A>(
      kind: string,
      schema: Schema.Codec<A, unknown>,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<A>, BotError>;
    readonly write: (
      kind: string,
      id: string,
      revision: number,
      data: unknown,
    ) => Effect.Effect<unknown, BotError>;
    readonly event: (kind: string, now: number) => Effect.Effect<unknown, BotError>;
    readonly enqueue: (
      id: string,
      kind: string,
      data: unknown,
      now: number,
      sourceId?: string,
    ) => Effect.Effect<void, BotError>;
    readonly append: (
      id: string,
      role: BotMessage["role"],
      text: string,
      sourceId?: string,
    ) => Effect.Effect<void, BotError>;
  }
>()("@t3tools/bot/Records") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const deliveries = yield* DeliveryStore.DeliveryStore;
  const read = <A>(kind: string, id: string, schema: Schema.Codec<A, unknown>) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        data: string;
      }>`SELECT data FROM records WHERE kind=${kind} AND id=${id}`;
      return rows[0]
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(rows[0].data)
        : null;
    });
  const list = <A>(kind: string, schema: Schema.Codec<A, unknown>, limit = 100) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        data: string;
      }>`SELECT data FROM records WHERE kind=${kind} ORDER BY rowid DESC LIMIT ${limit}`;
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.data),
      );
    });
  const write = (kind: string, id: string, revision: number, data: unknown) =>
    sql`INSERT INTO records(kind,id,revision,data) VALUES(${kind},${id},${revision},${serialize(data)}) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data`;
  const event = (kind: string, now: number) =>
    sql`INSERT INTO events(kind,created_at) VALUES(${kind},${now})`;
  const enqueue = (id: string, kind: string, data: unknown, now: number, sourceId?: string) =>
    Effect.gen(function* () {
      const jobId = stableId(kind, id);
      yield* sql`INSERT OR IGNORE INTO jobs(id,kind,data,due_at) VALUES(${jobId},${kind},${serialize(data)},${now})`;
      if (sourceId) yield* deliveries.inherit(jobId, sourceId);
    });
  const append = Effect.fn("BotRecords.append")(function* (
    id: string,
    role: BotMessage["role"],
    text: string,
    sourceId?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const messageId = role === "user" ? id : stableId("message", id);
        const inserted =
          yield* sql`INSERT OR IGNORE INTO messages(id,role,text,created_at) VALUES(${messageId},${role},${text.slice(0, 64000)},${now}) RETURNING id`;
        if (inserted.length && sourceId) yield* deliveries.queue(messageId, text, sourceId);
        if (inserted.length) yield* event("messages", now);
      }),
    );
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotError(cause) ? cause : new BotError({ category: "storage", cause }),
      ),
    );
  return Records.of({
    read: (kind, id, schema) => protect(read(kind, id, schema)),
    list: (kind, schema, limit) => protect(list(kind, schema, limit)),
    write: (kind, id, revision, data) => protect(write(kind, id, revision, data)),
    event: (kind, now) => protect(event(kind, now)),
    enqueue: (id, kind, data, now, source) => protect(enqueue(id, kind, data, now, source)),
    append: (id, role, text, source) => protect(append(id, role, text, source)),
  });
});
export const layer = Layer.effect(Records, make);
