// @effect-diagnostics globalFetch:off -- Exercise the real HTTP application boundary with an isolated fixture.
// @effect-diagnostics nodeBuiltinImport:off -- Test controls isolated application processes and an HTTP fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodePerfHooks from "node:perf_hooks";
import { expect, it } from "vite-plus/test";
import {
  DEFAULT_BOT_AVATAR,
  type BotBridgeCommand,
  type BotSnapshot,
} from "@t3tools/contracts/bot";

it("recovers a cloud task after process restart, deduplicates its result, and preserves memory", async (context) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3bot-e2e-"));
  const restoreHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3bot-restore-"));
  const children = new Set<NodeChildProcess.ChildProcess>();
  const owner = "fixture-owner-credential-not-a-real-secret";
  const requestedModels: string[] = [];
  let toolObserved!: () => void;
  const toolCheckpoint = new Promise<void>((resolve) => {
    toolObserved = resolve;
  });
  const fixture = NodeHttp.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string;
      messages: Array<{ role: string; content: string | null }>;
    };
    requestedModels.push(body.model);
    const gotTool = body.messages.some((m) => m.role === "tool");
    const resultWake = body.messages.some((m) =>
      m.content?.includes("Report the outcome accurately"),
    );
    const message =
      gotTool || resultWake
        ? {
            role: "assistant",
            content: resultWake
              ? "Research completed; evidence is attached."
              : "I started the cloud task.",
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "fixture-call",
                type: "function",
                function: {
                  name: "start_task",
                  arguments: JSON.stringify({
                    title: "Hosted research",
                    instructions: "Research independently",
                    environmentId: "cloud",
                    projectId: "workspace",
                    isolated: false,
                  }),
                },
              },
            ],
          };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 100 } }));
    if (gotTool) toolObserved();
  });
  fixture.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(fixture, "listening");
  const fixturePort = (fixture.address() as { port: number }).port;
  await NodeFSP.writeFile(
    NodePath.join(home, "config.json"),
    JSON.stringify({
      providers: [
        {
          id: "fixture",
          endpoint: `http://127.0.0.1:${fixturePort}`,
          model: "fixture",
          apiKeyEnv: "BOT_FIXTURE_KEY",
        },
        {
          id: "secondary",
          endpoint: `http://127.0.0.1:${fixturePort}`,
          model: "secondary-model",
          apiKeyEnv: "BOT_FIXTURE_KEY",
        },
      ],
      provider: "fixture",
      allowedOrigins: [],
      connectors: [
        {
          id: "slack",
          name: "Slack fixture",
          type: "slack",
          botTokenEnv: "SLACK_FIXTURE_TOKEN",
          signingSecretEnv: "SLACK_FIXTURE_SECRET",
          teamId: "TWORK",
          allowedUserIds: ["UOWNER"],
          allowedChannelIds: [],
        },
      ],
    }),
  );
  const start = (stateHome = home) =>
    new Promise<{ process: NodeChildProcess.ChildProcess; url: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.resolve(import.meta.dirname, "main.ts")],
        {
          env: {
            ...process.env,
            T3BOT_HOME: stateHome,
            T3BOT_PORT: "0",
            T3BOT_OWNER_TOKEN: owner,
            BOT_FIXTURE_KEY: "fixture",
            SLACK_FIXTURE_TOKEN: "fixture-slack-bot-token",
            SLACK_FIXTURE_SECRET: "fixture-slack-signing-secret",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let output = "";
      let diagnostics = "";
      child.stderr?.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
        if (match) resolve({ process: child, url: `http://127.0.0.1:${match[1]}` });
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!/listening on/.test(output))
          reject(new Error(`Bot startup failed (${code}): ${diagnostics}`));
      });
    });
  let bot: Awaited<ReturnType<typeof start>> | undefined;
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (bot && bot.process.exitCode === null && bot.process.signalCode === null) {
      const exit = NodeEvents.EventEmitter.once(bot.process, "exit");
      bot.process.kill(signal);
      await exit;
    }
    bot = undefined;
  };
  const request = async (path: string, body?: unknown, token = owner) => {
    const response = await fetch(`${bot!.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  context.onTestFinished(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = NodeEvents.EventEmitter.once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
    fixture.close();
  });
  try {
    bot = await start();
    const avatar = { ...DEFAULT_BOT_AVATAR, eyes: "visor", color: "rose", antenna: false } as const;
    await request("/api/command", { type: "avatar.save", requestId: "avatar", avatar });
    const rawChallenge = JSON.stringify({
      type: "url_verification",
      challenge: "verified-challenge",
    });
    const timestamp = String(
      Math.floor((NodePerfHooks.performance.timeOrigin + NodePerfHooks.performance.now()) / 1000),
    );
    const signature = `v0=${NodeCrypto.createHmac("sha256", "fixture-slack-signing-secret").update(`v0:${timestamp}:${rawChallenge}`).digest("hex")}`;
    const challenge = await fetch(`${bot.url}/connectors/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawChallenge,
    });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "verified-challenge" });
    const forged = await fetch(`${bot.url}/connectors/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawChallenge + " ",
    });
    expect(forged.status).toBe(401);
    await request("/api/command", {
      type: "settings",
      requestId: "settings",
      provider: "secondary",
      autoMemory: false,
    });
    const grant = (await request("/api/command", {
      type: "environment.create",
      requestId: "cloud",
      name: "Cloud",
    })) as { token: string };
    const poll = {
      protocol: 1,
      identity: "native-cloud-id",
      projects: [{ id: "workspace", title: "Workspace", instanceId: "codex", model: "fixture" }],
    };
    await request("/bridge/cloud/poll", poll, grant.token);
    await request("/api/command", {
      type: "memory.save",
      requestId: "remember",
      id: "format",
      revision: 0,
      scope: "user",
      text: "Concise reports",
    });
    const message = {
      type: "message",
      requestId: "research",
      text: "Research independently in your hosted workspace",
    };
    await request("/api/command", message);
    await request("/api/command", message);
    await toolCheckpoint;
    expect(requestedModels).toHaveLength(2);
    expect(requestedModels.every((model) => model === "secondary-model")).toBe(true);
    const first = (await request("/bridge/cloud/poll", poll, grant.token)) as {
      commands: BotBridgeCommand[];
    };
    expect(first.commands).toHaveLength(1);
    const command = first.commands[0]!;
    await stop("SIGKILL");
    bot = await start();
    const retry = (await request("/bridge/cloud/poll", poll, grant.token)) as {
      commands: BotBridgeCommand[];
    };
    expect(retry.commands[0]?.id).toBe(command.id);
    const report = {
      commandId: command.id,
      taskId: command.taskId,
      threadId: command.threadId,
      runId: "cloud-run",
      status: "completed",
      result: "Sources and research result",
    };
    await request("/bridge/cloud/report", report, grant.token);
    await request("/bridge/cloud/report", report, grant.token);
    const snapshot = (await request("/api/snapshot")) as BotSnapshot;
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.status).toBe("completed");
    expect(snapshot.memories[0]?.text).toBe("Concise reports");
    expect(snapshot.avatar).toEqual(avatar);
    expect(snapshot.messages.filter((m) => m.id === "research")).toHaveLength(1);
    expect(
      snapshot.messages.filter((m) => m.role === "system" && m.text.includes("completed")),
    ).toHaveLength(1);
    const denied = await fetch(`${bot.url}/api/snapshot`);
    expect(denied.status).toBe(401);
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile(
        process.execPath,
        [
          NodePath.resolve(import.meta.dirname, "main.ts"),
          "backup",
          NodePath.join(restoreHome, "bot.sqlite"),
        ],
        { env: { ...process.env, T3BOT_HOME: home } },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    await NodeFSP.copyFile(
      NodePath.join(home, "config.json"),
      NodePath.join(restoreHome, "config.json"),
    );
    await stop();
    bot = await start(restoreHome);
    const restored = (await request("/api/snapshot")) as BotSnapshot;
    expect(restored.tasks).toHaveLength(1);
    expect(restored.tasks[0]?.status).toBe("completed");
    expect(restored.memories[0]?.text).toBe("Concise reports");
    expect(restored.avatar).toEqual(avatar);
  } finally {
    await stop();
    fixture.close();
    await NodeFSP.rm(home, { recursive: true, force: true });
    await NodeFSP.rm(restoreHome, { recursive: true, force: true });
  }
}, 30000);
