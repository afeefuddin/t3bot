// @effect-diagnostics nodeBuiltinImport:off -- Exercise the CLI preflight in a separate process and isolated home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";

it("preflight validates configuration and schema without reclaiming or executing persisted work", async (context) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-preflight-"));
  const children = new Set<NodeChildProcess.ChildProcess>();
  context.onTestFinished(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await NodeFSP.rm(home, { recursive: true, force: true });
  });
  const config = NodePath.join(home, "config.json");
  await NodeFSP.writeFile(
    config,
    JSON.stringify({ providers: [], provider: "", allowedOrigins: [] }),
  );
  const check = () =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "main.ts"), "check"],
        {
          env: {
            ...process.env,
            T3BOT_HOME: home,
            T3BOT_CONFIG: config,
            T3BOT_OWNER_TOKEN: "fixture-owner-token-with-enough-length",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
  const initialized = await check();
  expect(initialized.code, initialized.output).toBe(0);
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "bot.sqlite"));
  db.exec(
    "INSERT INTO jobs(id,kind,data,state,due_at) VALUES ('untouched','coordinator','{}','running',0)",
  );
  db.exec(`INSERT INTO records VALUES ('process','untouched',1,'{"status":"running"}')`);
  db.close();
  const validated = await check();
  expect(validated.code, validated.output).toBe(0);
  expect(validated.output).toContain("no jobs were started");
  const after = new NodeSqlite.DatabaseSync(NodePath.join(home, "bot.sqlite"), { readOnly: true });
  expect(after.prepare("SELECT state,attempts FROM jobs WHERE id='untouched'").get()).toEqual({
    state: "running",
    attempts: 0,
  });
  expect(after.prepare("SELECT data FROM records WHERE id='untouched'").get()).toEqual({
    data: '{"status":"running"}',
  });
  after.close();
  await NodeFSP.writeFile(config, '{"providers":"invalid"}');
  const invalid = await check();
  expect(invalid.code).not.toBe(0);
});
