import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Processes from "./Processes.ts";
import * as Worker from "./Worker.ts";
// @effect-diagnostics nodeBuiltinImport:off -- CLI and HTTP framework boundary.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { BotBridgePoll, BotBridgeReport, BotCommand } from "@t3tools/contracts/bot";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { BotConfig, BotFileConfig, BotError, isBotError } from "./config.ts";
import * as Database from "./database.ts";
import * as Store from "./Store.ts";
import * as Model from "./Model.ts";
import * as Coordinator from "./Coordinator.ts";
import * as Connectors from "./Connectors.ts";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBridgePoll = Schema.decodeUnknownSync(BotBridgePoll);
const decodeBridgeReport = Schema.decodeUnknownSync(BotBridgeReport);
const decodeCommand = Schema.decodeUnknownSync(BotCommand);
const home = NodePath.resolve(process.env.T3BOT_HOME ?? ".t3bot");
await NodeFSP.mkdir(home, { recursive: true, mode: 0o700 });
if (process.argv[2] === "backup") {
  const destination = process.argv[3];
  if (!destination) throw new Error("Usage: main.ts backup /absolute/path/to/backup.sqlite");
  const source = new NodeSqlite.DatabaseSync(NodePath.join(home, "bot.sqlite"), { readOnly: true });
  try {
    await NodeSqlite.backup(source, NodePath.resolve(destination));
  } finally {
    source.close();
  }
  process.exit(0);
}
// An OS-released SQLite lock prevents a second coordinator from reclaiming live work in the same home.
const ownerLock = new NodeSqlite.DatabaseSync(NodePath.join(home, "owner-lock.sqlite"));
ownerLock.exec("BEGIN EXCLUSIVE");
const configPath = process.env.T3BOT_CONFIG ?? NodePath.join(home, "config.json");
let file: string;
try {
  file = await NodeFSP.readFile(configPath, "utf8");
} catch (cause) {
  if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  file = JSON.stringify({ providers: [], provider: "", allowedOrigins: [] }, null, 2);
  await NodeFSP.writeFile(configPath, file, { mode: 0o600, flag: "wx" });
}
const config = Schema.decodeUnknownSync(Schema.fromJsonString(BotFileConfig))(file);
if (new Set(config.connectors?.map((c) => c.id)).size !== (config.connectors?.length ?? 0))
  throw new Error("Configure unique connector IDs");
const configuredSecret = (name: string) => {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing configured connector credential environment variable: ${name}`);
  return value;
};
const connectors = (config.connectors ?? []).map((c) => {
  const verificationSecret = configuredSecret(
    c.type === "slack" ? c.signingSecretEnv : c.webhookSecretEnv,
  );
  if (c.type === "telegram" && !/^[A-Za-z0-9_-]{24,256}$/.test(verificationSecret))
    throw new Error("Telegram webhook secrets must contain 24-256 URL-safe characters");
  return { ...c, botToken: configuredSecret(c.botTokenEnv), verificationSecret };
});
if (
  new Set(config.providers.map((p) => p.id)).size !== config.providers.length ||
  (config.providers.length && !config.providers.some((p) => p.id === config.provider))
)
  throw new Error("Configure unique provider IDs and a valid selected provider");
for (const p of config.providers) {
  if ("type" in p) continue;
  const url = new URL(p.endpoint);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Provider endpoint must be an HTTP(S) URL without embedded credentials");
  if (p.apiKeyEnv && !process.env[p.apiKeyEnv])
    throw new Error(`Missing configured provider credential environment variable: ${p.apiKeyEnv}`);
}
const tokenPath = NodePath.join(home, "owner-token");
let ownerToken = process.env.T3BOT_OWNER_TOKEN;
if (!ownerToken) {
  try {
    ownerToken = (await NodeFSP.readFile(tokenPath, "utf8")).trim();
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    ownerToken = NodeCrypto.randomBytes(32).toString("base64url");
    await NodeFSP.writeFile(tokenPath, ownerToken, { mode: 0o600, flag: "wx" });
  }
}
if (ownerToken.length < 24) throw new Error("Owner token must contain at least 24 characters");
const owner = ownerToken;
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const ownerHash = Buffer.from(hash(owner));
const configLayer = Layer.succeed(
  BotConfig,
  BotConfig.of({
    providers: config.providers.map((p) => ({
      ...p,
      apiKey: "apiKeyEnv" in p && p.apiKeyEnv ? process.env[p.apiKeyEnv]! : "",
    })),
    workspace: NodePath.join(home, "workspace"),
    provider: config.provider,
    connectors,
  }),
);
const services = Layer.merge(Worker.layer, Connectors.layer).pipe(
  Layer.provideMerge(Coordinator.layer),
  Layer.provideMerge(Processes.layer),
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(Model.layer),
  Layer.provideMerge(Database.layer(NodePath.join(home, "bot.sqlite"))),
  Layer.provideMerge(configLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(NodeServices.layer),
);
const runtime = ManagedRuntime.make(services);
const run = async <A>(effect: Effect.Effect<A, BotError>): Promise<A> => {
  const result = await runtime.runPromise(Effect.result(effect));
  if (result._tag === "Failure") throw result.failure;
  return result.success;
};
const store = await runtime.runPromise(Store.Store);
const worker = await runtime.runPromise(Worker.Worker);
const connectorService = await runtime.runPromise(Connectors.Connectors);
await run(store.recover);
const processes = await runtime.runPromise(Processes.Processes);
await run(processes.recover);
let stopping = false;
runtime.runFork(worker.run);
if (connectors.length) runtime.runFork(connectorService.run);
const port = Number(process.env.T3BOT_PORT ?? 3780);
const host = process.env.T3BOT_HOST ?? "127.0.0.1";
const server = NodeHttp.createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json");
  const origin = request.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    response.writeHead(403).end('{"error":"origin_not_allowed"}');
    return;
  }
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  if (request.method === "OPTIONS") {
    response.setHeader("access-control-allow-headers", "authorization,content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-max-age", "600");
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const reply = (value: unknown) => response.end(JSON.stringify(value));
  try {
    if (url.pathname === "/health") {
      reply({ status: "ready", protocol: 1 });
      return;
    }
    const bridge = /^\/bridge\/([^/]+)\/(poll|report)$/.exec(url.pathname);
    const connector = /^\/connectors\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!bridge && !connector) {
      const candidate = Buffer.from(hash(bearer));
      if (!NodeCrypto.timingSafeEqual(candidate, ownerHash))
        throw new BotError({ category: "unauthorized" });
    }
    let body: unknown = null;
    let raw = "";
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 262144) throw new BotError({ category: "invalid" });
        chunks.push(Buffer.from(chunk));
      }
      raw = Buffer.concat(chunks).toString("utf8");
      if (!connector) body = decodeJson(raw);
    }
    if (connector && request.method === "POST") {
      reply(
        await run(
          connectorService.receive(
            connector[1]!,
            {
              "x-slack-request-timestamp":
                typeof request.headers["x-slack-request-timestamp"] === "string"
                  ? request.headers["x-slack-request-timestamp"]
                  : undefined,
              "x-slack-signature":
                typeof request.headers["x-slack-signature"] === "string"
                  ? request.headers["x-slack-signature"]
                  : undefined,
              "x-telegram-bot-api-secret-token":
                typeof request.headers["x-telegram-bot-api-secret-token"] === "string"
                  ? request.headers["x-telegram-bot-api-secret-token"]
                  : undefined,
            },
            raw,
          ),
        ),
      );
    } else if (bridge && request.method === "POST") {
      const id = decodeURIComponent(bridge[1]!);
      if (bridge[2] === "poll")
        reply(await run(store.poll(id, hash(bearer), decodeBridgePoll(body))));
      else {
        await run(store.report(id, hash(bearer), decodeBridgeReport(body)));
        reply({ ok: true });
      }
    } else if (url.pathname === "/api/snapshot" && request.method === "GET") {
      const before = url.searchParams.get("before");
      reply(
        await run(
          store.snapshot(
            before ? Number(before) : undefined,
            Number(url.searchParams.get("after") ?? 0),
          ),
        ),
      );
    } else if (url.pathname === "/api/events" && request.method === "GET")
      reply({ cursor: await run(store.changed(Number(url.searchParams.get("after") ?? 0))) });
    else if (url.pathname === "/api/command" && request.method === "POST") {
      const command = decodeCommand(body);
      const token = NodeCrypto.createHmac("sha256", owner)
        .update(`environment:${command.requestId}`)
        .digest("base64url");
      const result = await run(
        store.command(command, command.type === "environment.create" ? hash(token) : undefined),
      );
      reply(command.type === "environment.create" ? { id: command.requestId, token } : result);
    } else {
      response.writeHead(404);
      reply({ error: "not_found" });
    }
  } catch (cause) {
    const error = isBotError(cause) ? cause.category : "invalid";
    const status =
      error === "unauthorized"
        ? 401
        : error === "conflict"
          ? 409
          : error === "not_found"
            ? 404
            : error === "storage"
              ? 503
              : 400;
    response.writeHead(status);
    reply({ error });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port, host, () =>
  process.stdout.write(
    `t3bot listening on ${host}:${(server.address() as { port: number } | null)?.port ?? port}; home=${home}; owner credential file=${tokenPath}\n`,
  ),
);
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await runtime.dispose();
  ownerLock.close();
};
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
