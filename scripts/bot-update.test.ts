// @effect-diagnostics nodeBuiltinImport:off -- Exercise the deployment shell through an isolated Docker boundary fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { remoteUpdateCommand, shellQuote, updateOptions } from "./bot-update.ts";

it("accepts SSH aliases and a custom directory, and rejects option injection", () => {
  expect(updateOptions(["afeef-devbox"])).toEqual({
    host: "afeef-devbox",
    directory: "t3bot",
    rollback: false,
  });
  expect(updateOptions(["--rollback", "dev@host", "--directory", "/srv/my bot"])).toEqual({
    host: "dev@host",
    directory: "/srv/my bot",
    rollback: true,
  });
  expect(() => updateOptions([])).toThrow("Usage");
  expect(() => updateOptions(["-oProxyCommand=bad"])).toThrow("Usage");
  expect(() => updateOptions(["host;echo"])).toThrow("Usage");
  expect(() => updateOptions(["host", "--directory", "bad\npath"])).toThrow("Usage");
});

it("quotes directory names without executing shell substitutions", async () => {
  const value = "my 'bot' $(echo bad) `echo bad`";
  const result = await execute("bash", ["-c", `printf '%s' ${shellQuote(value)}`]);
  expect(result).toEqual({ code: 0, output: value });
});

async function execute(command: string, args: string[], env = process.env, input?: Uint8Array) {
  const child = NodeChildProcess.spawn(command, args, {
    env,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (input) child.stdin!.end(input);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    output += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, output };
}

async function fixture(scenario: string) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-update-test-"));
  try {
    const home = NodePath.join(directory, "state");
    const bin = NodePath.join(directory, "bin");
    await NodeFSP.mkdir(home);
    await NodeFSP.mkdir(bin);
    await NodeFSP.copyFile(
      NodePath.join(import.meta.dirname, "fixtures/bot-update-docker.mjs"),
      NodePath.join(bin, "docker"),
    );
    await NodeFSP.chmod(NodePath.join(bin, "docker"), 0o755);
    await NodeFSP.writeFile(NodePath.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "bot.sqlite"));
    db.exec(
      "CREATE TABLE jobs(id TEXT,state TEXT); CREATE TABLE connector_deliveries(state TEXT); CREATE TABLE records(kind TEXT,data TEXT); CREATE TABLE bot_schema(version INTEGER); INSERT INTO bot_schema VALUES (4); CREATE TABLE memory(text TEXT); INSERT INTO memory VALUES ('keep me');",
    );
    if (scenario === "delivery") db.exec("INSERT INTO connector_deliveries VALUES ('running')");
    if (scenario === "busy") db.exec("INSERT INTO jobs VALUES ('busy','running')");
    if (scenario === "process")
      db.exec(`INSERT INTO records VALUES ('process','{"status":"running"}')`);
    db.close();
    await NodeFSP.writeFile(NodePath.join(home, "owner-token"), "fixture-credential-preserved");
    const filename = NodePath.join(directory, "docker.json");
    const release = "0123456789abcdef0123";
    const server = NodeHttp.createServer(async (_req, res) => {
      const state = JSON.parse(await NodeFSP.readFile(filename, "utf8")) as { current: string };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "ready",
          release:
            state.current === "sha256:old"
              ? undefined
              : scenario === "mismatch"
                ? "wrong"
                : release,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    await NodeFSP.writeFile(
      filename,
      JSON.stringify({
        scenario,
        release,
        home,
        port: address.port,
        current: "sha256:old",
        healthy: true,
        tags: { "t3bot:local": "sha256:old" },
        calls: [],
      }),
    );
    const read = async () =>
      JSON.parse(await NodeFSP.readFile(filename, "utf8")) as {
        current: string;
        stopped: boolean;
        tags: Record<string, string>;
        calls: string[];
      };
    return {
      home,
      directory,
      read,
      run: (rollback = false) =>
        execute(
          "bash",
          [
            NodePath.join(import.meta.dirname, "bot-update-remote.sh"),
            directory,
            release,
            rollback ? "rollback" : "update",
          ],
          { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOT_UPDATE_FIXTURE: filename },
        ),
      runThroughStdin: async () =>
        execute(
          "bash",
          ["-c", remoteUpdateCommand(directory, release, "update")],
          { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOT_UPDATE_FIXTURE: filename },
          await NodeFSP.readFile(NodePath.join(import.meta.dirname, "bot-update-remote.sh")),
        ),
      async [Symbol.asyncDispose]() {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await NodeFSP.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

it("updates, backs up committed data, preserves credentials, and rolls back without rewinding memory", async () => {
  await using bot = await fixture("success");
  expect(await bot.run()).toMatchObject({ code: 0 });
  expect((await bot.read()).current).toBe("sha256:new");
  expect(await NodeFSP.readFile(NodePath.join(bot.directory, ".updates/previous"), "utf8")).toBe(
    "sha256:old\n4\n",
  );
  const backup = (
    await NodeFSP.readFile(NodePath.join(bot.directory, ".updates/last-backup"), "utf8")
  ).trim();
  const snapshot = new NodeSqlite.DatabaseSync(
    NodePath.join(bot.home, ".updates", backup, "bot.sqlite"),
    {
      readOnly: true,
    },
  );
  expect(snapshot.prepare("SELECT text FROM memory").get()).toEqual({ text: "keep me" });
  snapshot.close();
  const db = new NodeSqlite.DatabaseSync(NodePath.join(bot.home, "bot.sqlite"));
  db.exec("INSERT INTO memory VALUES ('after update')");
  db.close();
  const rollback = await bot.run(true);
  expect(rollback.code, rollback.output).toBe(0);
  expect((await bot.read()).current).toBe("sha256:old");
  const current = new NodeSqlite.DatabaseSync(NodePath.join(bot.home, "bot.sqlite"), {
    readOnly: true,
  });
  expect(current.prepare("SELECT count(*) AS n FROM memory").get()).toEqual({ n: 2 });
  current.close();
  expect(await NodeFSP.readFile(NodePath.join(bot.home, "owner-token"), "utf8")).toBe(
    "fixture-credential-preserved",
  );
});

it("runs the complete update when SSH delivers the script through stdin", async () => {
  await using bot = await fixture("success");
  const result = await bot.runThroughStdin();
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Bot updated successfully");
  expect((await bot.read()).current).toBe("sha256:new");
  expect(
    (await NodeFSP.readdir(NodePath.join(bot.directory, ".updates"))).some((name) =>
      name.startsWith("updater."),
    ),
  ).toBe(false);
});

it.each(["build", "preflight", "schema", "busy", "process", "delivery"])(
  "leaves the old service running on %s failure",
  async (scenario) => {
    await using bot = await fixture(scenario);
    const result = await bot.run();
    expect(result.code, result.output).not.toBe(0);
    const state = await bot.read();
    expect(state.current).toBe("sha256:old");
    expect(state.tags["t3bot:local"]).toBe("sha256:old");
    expect(state.calls.some((call) => call.includes("compose -f compose.yaml stop"))).toBe(false);
  },
);

it.each(["health", "mismatch", "race"])(
  "restores the previous service on %s failure",
  async (scenario) => {
    await using bot = await fixture(scenario);
    const result = await bot.run();
    expect(result.code, result.output).not.toBe(0);
    const state = await bot.read();
    expect(state.current).toBe("sha256:old");
    expect(state.tags["t3bot:local"]).toBe("sha256:old");
    expect(state.stopped).toBe(false);
    expect(result.output).toContain("restoring the previous image");
  },
);

it("refuses rollback without a prior release", async () => {
  await using bot = await fixture("success");
  const result = await bot.run(true);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("No previous successful release");
  expect((await bot.read()).current).toBe("sha256:old");
});

it("refuses rollback if the database changed schema since the previous release", async () => {
  await using bot = await fixture("success");
  const update = await bot.run();
  expect(update.code, update.output).toBe(0);
  const db = new NodeSqlite.DatabaseSync(NodePath.join(bot.home, "bot.sqlite"));
  db.exec("UPDATE bot_schema SET version=5");
  db.close();
  const result = await bot.run(true);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Database schema changed");
  expect((await bot.read()).current).toBe("sha256:new");
});
