// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Deployment CLI owns local builds, SSH subprocesses, and terminal output.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const usage = "Usage: vp run bot:update <ssh-host> [--directory <compose-directory>] [--rollback]";

export function updateOptions(args: ReadonlyArray<string>) {
  let host: string | undefined;
  let directory = "t3bot";
  let rollback = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--rollback") rollback = true;
    else if (arg === "--directory") {
      const value = args[++index];
      if (!value || value.startsWith("-") || /[\r\n\0]/.test(value)) throw new Error(usage);
      directory = value;
    } else if (!host && /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(arg)) host = arg;
    else throw new Error(usage);
  }
  if (!host) throw new Error(usage);
  return { host, directory, rollback };
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function remoteUpdateCommand(
  directory: string,
  release: string,
  operation: "update" | "rollback",
) {
  // Save stdin first: Docker's attached commands can otherwise consume a bash -s script.
  return `set -e; cd -- ${shellQuote(directory)}; umask 077; mkdir -p .updates; updater=$(mktemp .updates/updater.XXXXXX); trap 'rm -f -- "$updater"' EXIT; cat > "$updater"; bash "$updater" . ${shellQuote(release)} ${operation}`;
}

async function run(command: string, args: ReadonlyArray<string>, input?: Uint8Array) {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: root,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: [input ? "pipe" : "ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)),
    );
    if (input) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    }
  });
}

async function main() {
  const options = updateOptions(process.argv.slice(2));
  const ssh = (command: string, input?: Uint8Array) =>
    run(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", options.host, command],
      input,
    );
  const remoteScript = await NodeFSP.readFile(NodePath.join(root, "scripts/bot-update-remote.sh"));
  if (options.rollback) {
    await ssh(remoteUpdateCommand(options.directory, "rollback", "rollback"), remoteScript);
    return;
  }
  console.log(`Building the current checkout for ${options.host}…`);
  await run(NodePath.join(root, "node_modules/.bin/vp"), [
    "run",
    "--filter",
    "@t3tools/bot",
    "build",
  ]);
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3bot-update-"));
  try {
    const runtime = NodePath.join(staging, "runtime");
    await NodeFSP.mkdir(runtime);
    // Only explicit build outputs leave this machine; no config, credentials, or runtime state.
    const files = (await NodeFSP.readdir(NodePath.join(root, "apps/bot/dist")))
      .filter((name) => !name.startsWith("._"))
      .sort();
    if (!files.includes("main.mjs")) throw new Error("Bot build did not produce main.mjs");
    const digest = NodeCrypto.createHash("sha256");
    for (const name of files) {
      const contents = await NodeFSP.readFile(NodePath.join(root, "apps/bot/dist", name));
      digest.update(name).update("\0").update(contents);
      await NodeFSP.writeFile(NodePath.join(runtime, name), contents);
    }
    const dockerfile = await NodeFSP.readFile(NodePath.join(root, "apps/bot/Dockerfile.release"));
    digest.update(dockerfile);
    const release = digest.digest("hex").slice(0, 20);
    await NodeFSP.writeFile(NodePath.join(staging, "Dockerfile"), dockerfile);
    const archive = NodePath.join(staging, "release.tar.gz");
    await run("tar", ["-czf", archive, "--exclude=._*", "-C", staging, "Dockerfile", "runtime"]);
    await ssh(
      `cd -- ${shellQuote(options.directory)} && umask 077 && mkdir -p .updates/${release} && tar -xzf - -C .updates/${release}`,
      await NodeFSP.readFile(archive),
    );
    await ssh(remoteUpdateCommand(options.directory, release, "update"), remoteScript);
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main)
  await main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : "Bot update failed");
    process.exitCode = 1;
  });
