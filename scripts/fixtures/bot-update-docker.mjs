#!/usr/bin/env node
// Docker boundary fixture: the updater's SQLite and health programs run unchanged.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
const filename = process.env.BOT_UPDATE_FIXTURE;
const state = JSON.parse(NodeFS.readFileSync(filename, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => NodeFS.writeFileSync(filename, JSON.stringify(state));
const old = "sha256:old";
const next = "sha256:new";
const image = (ref) => state.tags[ref] || ref;
const fail = (message) => {
  save();
  console.error(message);
  process.exit(1);
};
if (args[0] === "build") {
  if (state.scenario === "build") fail("fixture build failure");
  const ref = args[args.indexOf("-t") + 1];
  state.tags[ref] = next;
} else if (args[0] === "tag") {
  state.tags[args[2]] = image(args[1]);
} else if (args[0] === "inspect" || args[0] === "image") {
  const format = args[args.indexOf("--format") + 1];
  const ref = args.at(-1);
  if (format === "{{.Image}}") console.log(state.current);
  else if (format === "{{.Config.Image}}") console.log("t3bot:local");
  else if (format === "{{.Id}}") console.log(image(ref));
  else if (format.includes("Healthcheck")) console.log("yes");
  else if (format.includes("Health.Status")) console.log(state.healthy ? "healthy" : "unhealthy");
  else if (format.includes("io.t3bot.release"))
    console.log(image(ref) === old ? "<no value>" : state.release);
  else fail("Unknown inspect format: " + format);
} else if (args[0] === "compose") {
  const command = args[3];
  if (command === "ps") console.log("fixture-bot");
  else if (command === "stop") {
    state.stopped = true;
    if (state.scenario === "race") {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(state.home, "bot.sqlite"));
      db.exec("INSERT INTO jobs VALUES ('race','running')");
      db.close();
    }
  } else if (command === "up") {
    state.current = state.tags["t3bot:local"];
    state.stopped = false;
    state.healthy = !(state.scenario === "health" && state.current === next);
    if (!state.healthy) fail("fixture health failure");
  } else if (command === "exec" || command === "run") {
    if (command === "run" && args.includes("--pull")) fail("unknown flag: --pull (Compose 2.26)");
    const node = args.indexOf("node");
    if (node < 0) fail("Expected node invocation");
    let home = state.home;
    const override = args.find((arg) => arg.startsWith("T3BOT_HOME="));
    if (override) home = override.slice("T3BOT_HOME=".length);
    if (args.at(-1) === "check") {
      if (state.scenario === "preflight") fail("fixture configuration failure");
      if (state.scenario === "schema") {
        const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "bot.sqlite"));
        db.exec("UPDATE bot_schema SET version=5");
        db.close();
      }
    } else {
      save();
      // Docker attaches and drains stdin even for node -e programs that never read it.
      const input = NodeFS.readFileSync(0);
      const result = NodeChildProcess.spawnSync(process.execPath, args.slice(node + 1), {
        env: { ...process.env, T3BOT_HOME: home, T3BOT_PORT: String(state.port) },
        input,
        stdio: ["pipe", "inherit", "inherit"],
      });
      process.exit(result.status ?? 1);
    }
  } else fail("Unknown compose command: " + command);
} else fail("Unknown docker invocation: " + args.join(" "));
save();
