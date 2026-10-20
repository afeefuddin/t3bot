import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* sql`PRAGMA synchronous = FULL`;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA busy_timeout = 5000`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS bot_schema (version INTEGER PRIMARY KEY)`;
      const versions = yield* sql<{ version: number }>`SELECT version FROM bot_schema`;
      if (versions.some((row) => row.version > 3))
        return yield* Effect.die(new Error("Bot database was created by a newer version"));
      if (versions.some((row) => row.version === 3)) return;
      if (versions.length === 0) {
        yield* sql`CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`;
        yield* sql`CREATE VIRTUAL TABLE history_search USING fts5(text, content='messages', content_rowid='seq')`;
        yield* sql`CREATE TRIGGER messages_insert AFTER INSERT ON messages BEGIN INSERT INTO history_search(rowid,text) VALUES(new.seq,new.text); END`;
        yield* sql`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))`;
        yield* sql`CREATE TABLE receipts (id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL)`;
        yield* sql`CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, lease_until INTEGER, generation INTEGER NOT NULL DEFAULT 0, error TEXT)`;
        yield* sql`CREATE INDEX jobs_due ON jobs(state,due_at)`;
        yield* sql`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, created_at INTEGER NOT NULL)`;
        yield* sql`CREATE TABLE environments (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, identity TEXT, revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, projects TEXT NOT NULL DEFAULT '[]')`;
        yield* sql`CREATE TABLE bridge_commands (id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id), task_id TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', last_delivery INTEGER NOT NULL DEFAULT 0)`;
        yield* sql`CREATE INDEX bridge_pending ON bridge_commands(environment_id,state,last_delivery)`;
        yield* sql`CREATE TABLE turns (id TEXT PRIMARY KEY, messages TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0)`;
        yield* sql`CREATE TABLE model_steps (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
        yield* sql`INSERT INTO bot_schema VALUES (1)`;
      }
      if (!versions.some((row) => row.version === 2)) {
        yield* sql`CREATE TABLE connector_routes (source_id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, destination TEXT NOT NULL)`;
        yield* sql`CREATE TABLE connector_deliveries (id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, destination TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, lease_until INTEGER, generation INTEGER NOT NULL DEFAULT 0, error TEXT)`;
        yield* sql`CREATE INDEX connector_deliveries_due ON connector_deliveries(state,due_at)`;
      }
      yield* sql`ALTER TABLE environments ADD COLUMN providers TEXT NOT NULL DEFAULT '[]'`;
      yield* sql`UPDATE bot_schema SET version=3`;
    }),
  );
});

export const layer = (filename: string) =>
  Layer.effectDiscard(setup).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
