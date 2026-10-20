// @effect-diagnostics globalFetch:off -- Imperative client transport boundary shared by React and React Native.
// @effect-diagnostics globalTimers:off -- This adapter owns one abortable network retry loop per connected client.
import { BotSnapshot, BotCommand, type BotMessage } from "@t3tools/contracts/bot";
import * as Schema from "effect/Schema";

export interface BotConnection {
  readonly url: string;
  readonly token: string;
}
export interface BotClientState {
  readonly snapshot: BotSnapshot | null;
  readonly connected: boolean;
  readonly error: string | null;
}
const decodeSnapshot = Schema.decodeUnknownSync(BotSnapshot);
const decodeCommand = Schema.decodeUnknownSync(BotCommand);

export function normalizeBotConnection(connection: BotConnection): BotConnection {
  const url = new URL(connection.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Enter an HTTP(S) bot URL without credentials or query parameters");
  if (connection.token.trim().length < 24) throw new Error("Enter the bot owner credential");
  return { url: url.toString().replace(/\/$/, ""), token: connection.token.trim() };
}

export class BotClient {
  private state: BotClientState = { snapshot: null, connected: false, error: null };
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private readonly pending = new Map<string, BotCommand>();
  readonly connection: BotConnection;
  private readonly request: typeof fetch;
  constructor(connection: BotConnection, request: typeof fetch = fetch) {
    this.connection = normalizeBotConnection(connection);
    // Browser fetch rejects a BotClient receiver when invoked through this field.
    this.request = request.bind(globalThis);
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.state;
  private publish(patch: Partial<BotClientState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const deadline = new AbortController();
    const parent = this.controller?.signal;
    const abort = () => deadline.abort();
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) deadline.abort();
    const timer = setTimeout(abort, 15000);
    try {
      const response = await this.request(`${this.connection.url}${path}`, {
        ...init,
        signal: deadline.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.connection.token}`,
          ...init?.headers,
        },
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Bot credential was rejected. Reconnect in Settings."
            : `Bot request failed (${response.status}).`,
        );
      return await response.json();
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    }
  }
  async refresh() {
    const snapshot = decodeSnapshot(
      await this.json(`/api/snapshot?after=${this.state.snapshot?.messages.at(-1)?.seq ?? 0}`),
    );
    if (this.state.snapshot && snapshot.cursor < this.state.snapshot.cursor) return;
    const previous = this.state.snapshot?.messages ?? [];
    const hasGap =
      previous.length > 0 &&
      snapshot.messages.length > 0 &&
      snapshot.messages[0]!.seq > previous.at(-1)!.seq + 1;
    const existing = hasGap ? [] : previous;
    const byId = new Map<string, BotMessage>(existing.map((m) => [m.id, m]));
    for (const message of snapshot.messages) byId.set(message.id, message);
    this.publish({
      snapshot: { ...snapshot, messages: [...byId.values()].sort((a, b) => a.seq - b.seq) },
      connected: true,
      error: null,
    });
  }
  async older() {
    const first = this.state.snapshot?.messages[0]?.seq;
    if (!first) return;
    const page = decodeSnapshot(await this.json(`/api/snapshot?before=${first}`));
    const current = this.state.snapshot;
    if (current) {
      const messages = new Map([...page.messages, ...current.messages].map((m) => [m.id, m]));
      this.publish({
        snapshot: { ...current, messages: [...messages.values()].sort((a, b) => a.seq - b.seq) },
      });
    }
  }
  async command(input: BotCommand): Promise<unknown> {
    const command = decodeCommand(input);
    const existing = this.pending.get(command.requestId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(command))
      throw new Error("This request ID was already used");
    this.pending.set(command.requestId, command);
    try {
      const result = await this.json("/api/command", {
        method: "POST",
        body: JSON.stringify(command),
      });
      this.pending.delete(command.requestId);
      await this.refresh().catch(() =>
        this.publish({
          connected: false,
          error: "Request saved; reconnecting to refresh activity.",
        }),
      );
      return result;
    } catch (cause) {
      this.publish({ error: cause instanceof Error ? cause.message : "Bot request failed" });
      throw cause;
    }
  }
  async retryPending() {
    for (const command of this.pending.values()) await this.command(command);
  }
  start() {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    const loop = async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          if (!this.state.snapshot) await this.refresh();
          else {
            const event = (await this.json(`/api/events?after=${this.state.snapshot.cursor}`)) as {
              cursor?: unknown;
            };
            if (typeof event.cursor !== "number") throw new Error("Invalid bot event response");
            if (event.cursor !== this.state.snapshot.cursor || !this.state.connected)
              await this.refresh();
          }
          delay = 2000;
        } catch (cause) {
          if (controller.signal.aborted) break;
          this.publish({
            connected: false,
            error: cause instanceof Error ? cause.message : "Bot disconnected",
          });
          delay = Math.min(delay * 2, 30000);
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
    };
    void loop();
    return () => {
      controller.abort();
      if (this.controller === controller) this.controller = null;
    };
  }
  stop() {
    this.controller?.abort();
    this.controller = null;
  }
}

export function getBotReplyActivity(jobs: BotSnapshot["jobs"]) {
  const active = jobs.filter(
    (job) => job.kind === "turn" && (job.state === "pending" || job.state === "running"),
  );
  const running = active.some((job) => job.state === "running");
  const retrying = active.some((job) => job.state === "pending" && job.error !== null);
  return {
    phase: running ? "thinking" : retrying ? "retrying" : active.length ? "queued" : "idle",
    count: active.length,
  } as const;
}
