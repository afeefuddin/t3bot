import { stableId } from "@t3tools/shared/stableId";
import type { BotConnector, BotJob } from "@t3tools/contracts/bot";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { BotConfig, BotError, isBotError } from "./config.ts";
import { serialize } from "./json.ts";

export const Destination = Schema.Union([
  Schema.Struct({ type: Schema.Literal("slack"), channel: Schema.String, threadTs: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("telegram"),
    chatId: Schema.String,
    messageId: Schema.Number,
  }),
]);
export type Destination = typeof Destination.Type;
const decodeDestination = Schema.decodeEffect(Schema.fromJsonString(Destination));
const Delivery = Schema.Struct({
  id: Schema.String,
  connector_id: Schema.String,
  destination: Schema.fromJsonString(Destination),
  text: Schema.String,
  attempts: Schema.Number,
  generation: Schema.Number,
});
export type Delivery = typeof Delivery.Type;
const decodeDelivery = Schema.decodeEffect(Delivery);
export interface DeliveryFailure {
  readonly category: "unauthorized" | "invalid" | "unavailable" | "rate_limited";
  readonly retryAfterMs?: number;
}

export class DeliveryStore extends Context.Service<
  DeliveryStore,
  {
    readonly bind: (
      sourceId: string,
      connectorId: string,
      destination: Destination,
    ) => Effect.Effect<void, BotError>;
    readonly inherit: (targetId: string, sourceId: string) => Effect.Effect<void, BotError>;
    readonly queue: (
      messageId: string,
      text: string,
      sourceId: string,
    ) => Effect.Effect<void, BotError>;
    readonly enabled: (id: string) => Effect.Effect<boolean, BotError>;
    readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void, BotError>;
    readonly claim: Effect.Effect<Delivery | null, BotError>;
    readonly finish: (
      delivery: Delivery,
      failure?: DeliveryFailure,
    ) => Effect.Effect<void, BotError>;
    readonly retry: (id: string) => Effect.Effect<void, BotError>;
    readonly recover: Effect.Effect<void, BotError>;
    readonly snapshot: Effect.Effect<ReadonlyArray<BotConnector>, BotError>;
    readonly jobs: Effect.Effect<ReadonlyArray<BotJob>, BotError>;
  }
>()("@t3tools/bot/DeliveryStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* BotConfig;
  const connectors = config.connectors ?? [];
  const touch = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO events(kind,created_at) VALUES('connectors',${now})`;
  });
  const enabled = (id: string) =>
    Effect.gen(function* () {
      if (!connectors.some((c) => c.id === id)) return false;
      const rows = yield* sql<{
        enabled: number;
      }>`SELECT json_extract(data,'$.enabled') AS enabled FROM records WHERE kind='connector' AND id=${id}`;
      return rows[0]?.enabled !== 0;
    });
  const setEnabled = (id: string, value: boolean) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (!connectors.some((c) => c.id === id))
          return yield* new BotError({ category: "not_found" });
        yield* sql`INSERT INTO records(kind,id,revision,data) VALUES('connector',${id},0,${serialize({ enabled: value })}) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`;
        yield* touch;
      }),
    );
  const bind = (sourceId: string, connectorId: string, destination: Destination) =>
    Effect.gen(function* () {
      const encoded = serialize(destination);
      const old = yield* sql<{
        connector_id: string;
        destination: string;
      }>`SELECT connector_id,destination FROM connector_routes WHERE source_id=${sourceId}`;
      if (old[0] && (old[0].connector_id !== connectorId || old[0].destination !== encoded))
        return yield* new BotError({ category: "conflict" });
      yield* sql`INSERT OR IGNORE INTO connector_routes(source_id,connector_id,destination) VALUES(${sourceId},${connectorId},${encoded})`;
    });
  const inherit = (targetId: string, sourceId: string) =>
    Effect.gen(function* () {
      if (targetId === sourceId) return;
      yield* sql`DELETE FROM connector_routes WHERE source_id=${targetId}`;
      yield* sql`INSERT INTO connector_routes(source_id,connector_id,destination) SELECT ${targetId},connector_id,destination FROM connector_routes WHERE source_id=${sourceId}`;
    });
  const queue = (messageId: string, text: string, sourceId: string) =>
    Effect.gen(function* () {
      if (!text.trim()) return;
      const route = (yield* sql<{
        connector_id: string;
        destination: string;
      }>`SELECT connector_id,destination FROM connector_routes WHERE source_id=${sourceId}`)[0];
      if (!route) return;
      yield* decodeDestination(route.destination);
      const now = yield* Clock.currentTimeMillis;
      // Code-point chunks preserve emoji and fit both services' plain-text message limits.
      const points = Array.from(text.slice(0, 64000));
      for (let offset = 0; offset < points.length; offset += 3000) {
        const id = stableId("delivery", route.connector_id, messageId, offset);
        yield* sql`INSERT OR IGNORE INTO connector_deliveries(id,connector_id,destination,text,due_at) VALUES(${id},${route.connector_id},${route.destination},${points.slice(offset, offset + 3000).join("")},${now})`;
      }
      yield* touch;
    });
  const claim = sql.withTransaction(
    Effect.gen(function* () {
      const active = yield* Effect.filter(connectors, (c) => enabled(c.id));
      if (!active.length) return null;
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        id: string;
        connector_id: string;
        destination: string;
        text: string;
        attempts: number;
        generation: number;
      }>`UPDATE connector_deliveries SET state='running',attempts=attempts+1,generation=generation+1,lease_until=${now + 60000} WHERE id=(SELECT d.id FROM connector_deliveries d WHERE ${sql.in(
        "d.connector_id",
        active.map((c) => c.id),
      )} AND ((d.state='pending' AND d.due_at<=${now}) OR (d.state='running' AND d.lease_until<${now})) AND NOT EXISTS(SELECT 1 FROM connector_deliveries earlier WHERE earlier.connector_id=d.connector_id AND earlier.destination=d.destination AND earlier.rowid<d.rowid AND earlier.state IN ('pending','running')) ORDER BY d.rowid LIMIT 1) RETURNING id,connector_id,destination,text,attempts,generation`;
      return rows[0] ? yield* decodeDelivery(rows[0]) : null;
    }),
  );
  const finish = (delivery: Delivery, failure?: DeliveryFailure) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const permanent =
          failure &&
          (failure.category === "unauthorized" ||
            failure.category === "invalid" ||
            (delivery.attempts >= 8 && failure.category !== "rate_limited"));
        const state = failure ? (permanent ? "failed" : "pending") : "done";
        const backoff = Math.min(300000, 2000 * 2 ** Math.min(delivery.attempts, 8));
        const delay =
          failure?.retryAfterMs === undefined
            ? backoff
            : Math.min(3600000, Math.max(1000, failure.retryAfterMs));
        yield* sql`UPDATE connector_deliveries SET state=${state},lease_until=NULL,error=${failure?.category ?? null},due_at=${now + delay},attempts=attempts-${failure?.category === "rate_limited" ? 1 : 0} WHERE id=${delivery.id} AND generation=${delivery.generation} AND state='running'`;
        yield* touch;
      }),
    );
  const snapshot = Effect.forEach(connectors, (c) =>
    Effect.gen(function* () {
      const counts = yield* sql<{
        pending: number;
        failed: number;
      }>`SELECT COALESCE(SUM(state IN ('pending','running')),0) AS pending,COALESCE(SUM(state='failed'),0) AS failed FROM connector_deliveries WHERE connector_id=${c.id}`;
      const errors = yield* sql<{
        error: string;
      }>`SELECT error FROM connector_deliveries WHERE connector_id=${c.id} AND error IS NOT NULL AND state!='done' ORDER BY rowid DESC LIMIT 1`;
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        enabled: yield* enabled(c.id),
        pending: counts[0]?.pending ?? 0,
        failed: counts[0]?.failed ?? 0,
        lastError: errors[0]?.error ?? null,
      } satisfies BotConnector;
    }),
  );
  const retry = (id: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE connector_deliveries SET state='pending',attempts=0,error=NULL,due_at=${now} WHERE id=${id} AND state='failed'`;
        yield* touch;
      }),
    );
  const recover = sql`UPDATE connector_deliveries SET state='pending',generation=generation+1,lease_until=NULL WHERE state='running'`;
  const jobs = sql<BotJob>`SELECT id,'delivery:'||connector_id AS kind,state,attempts,due_at AS dueAt,error FROM connector_deliveries WHERE state!='done' ORDER BY due_at LIMIT 50`;
  const protect = <A, E>(value: Effect.Effect<A, E>) =>
    value.pipe(
      Effect.mapError((cause) =>
        isBotError(cause) ? cause : new BotError({ category: "storage", cause }),
      ),
    );
  return DeliveryStore.of({
    bind: (...a) => protect(bind(...a)),
    inherit: (...a) => protect(inherit(...a)),
    queue: (...a) => protect(queue(...a)),
    enabled: (id) => protect(enabled(id)),
    setEnabled: (...a) => protect(setEnabled(...a)),
    claim: protect(claim),
    finish: (...a) => protect(finish(...a)),
    retry: (id) => protect(retry(id)),
    recover: protect(Effect.asVoid(recover)),
    snapshot: protect(snapshot),
    jobs: protect(jobs),
  });
});
export const layer = Layer.effect(DeliveryStore, make);
