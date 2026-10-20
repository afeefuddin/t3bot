// @effect-diagnostics nodeBuiltinImport:off -- Seed a prior on-disk schema to verify the real upgrade path.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Database from "./database.ts";

it.effect("upgrades v2 without losing project grants or conversations and reopens safely", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-v2-upgrade-" });
    const filename = `${directory}/bot.sqlite`;
    yield* Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(filename);
      try {
        db.exec(
          "CREATE TABLE bot_schema(version INTEGER PRIMARY KEY); INSERT INTO bot_schema VALUES(2); CREATE TABLE environments(id TEXT PRIMARY KEY,name TEXT,token_hash TEXT,identity TEXT,revoked INTEGER,last_seen INTEGER,projects TEXT); INSERT INTO environments VALUES('machine','My machine','hash','identity',0,123,'[]'); CREATE TABLE messages(id TEXT PRIMARY KEY,text TEXT); INSERT INTO messages VALUES('message','Keep this history');",
        );
      } finally {
        db.close();
      }
    });
    const check = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ version: number }>`SELECT version FROM bot_schema`)[0]?.version,
        3,
      );
      assert.deepEqual(
        (yield* sql<{ id: string; providers: string }>`SELECT id,providers FROM environments`)[0],
        { id: "machine", providers: "[]" },
      );
      assert.equal(
        (yield* sql<{ text: string }>`SELECT text FROM messages`)[0]?.text,
        "Keep this history",
      );
    });
    yield* Effect.scoped(check.pipe(Effect.provide(Database.layer(filename))));
    yield* Effect.scoped(check.pipe(Effect.provide(Database.layer(filename))));
  }).pipe(Effect.provide(NodeServices.layer)),
);
