import { expect, it, vi } from "vite-plus/test";
import { BotClient, getBotReplyActivity, resolveBotThreadTarget } from "./bot.ts";
import type { BotSnapshot } from "@t3tools/contracts/bot";

const snapshot = (cursor: number): BotSnapshot => ({
  protocol: 1,
  cursor,
  readThrough: 0,
  unread: 0,
  messages: [],
  memories: [],
  responsibilities: [],
  tasks: [],
  environments: [],
  jobs: [],
  providers: ["fixture"],
  provider: "fixture",
  autoMemory: true,
});
const connection = {
  url: "https://bot.example.test",
  token: "fixture-owner-token-for-client-tests",
};

it("opens a bot worker using its connected T3 identity, not its bot grant ID", () => {
  const environments = [{ id: "bot-grant", name: "Mac worker", identity: "t3-server" }];
  expect(
    resolveBotThreadTarget(
      { environmentId: "bot-grant", threadId: "worker-thread" },
      environments,
      ["t3-server"],
    ),
  ).toEqual({ environmentId: "t3-server", threadId: "worker-thread" });
});

it("keeps bot workers on the bot page when their server is absent or disconnected", () => {
  const task = { environmentId: "bot-grant", threadId: "worker-thread" };
  const environments = [{ id: "bot-grant", name: "Mac worker", identity: "t3-server" }];
  for (const connectedIds of [[], ["another-server"], ["bot-grant"]]) {
    expect(() => resolveBotThreadTarget(task, environments, connectedIds)).toThrow(
      "Connect Mac worker in Settings > Connections to open this thread.",
    );
  }
});

it("explains workers whose environment identity or thread has not been received", () => {
  const task = { environmentId: "bot-grant", threadId: "worker-thread" };
  expect(() => resolveBotThreadTarget(task, [], [])).toThrow("not available");
  expect(() =>
    resolveBotThreadTarget(task, [{ id: "bot-grant", name: "Mac worker", identity: null }], []),
  ).toThrow("not available");
  expect(() => resolveBotThreadTarget({ ...task, threadId: null }, [], [])).toThrow(
    "not created a thread",
  );
});
it("connects with a browser transport that requires the global receiver", async (context) => {
  const browserFetch: typeof fetch = async function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Response.json(snapshot(1));
  };
  vi.stubGlobal("fetch", browserFetch);
  context.onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const client = new BotClient(connection);
  await client.refresh();
  expect(client.getSnapshot().connected).toBe(true);
});
it("retries an uncertain send using the original request identity", async () => {
  const bodies: string[] = [];
  let fail = true;
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") {
      bodies.push(String(init.body));
      if (fail) {
        fail = false;
        throw new Error("Connection lost after acceptance");
      }
      return Response.json({ ok: true });
    }
    return Response.json(snapshot(1));
  };
  const client = new BotClient(connection, transport);
  await expect(
    client.command({ type: "message", requestId: "original", text: "Start work" }),
  ).rejects.toThrow();
  await client.retryPending();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
});
it("does not turn a successful command into an uncertain send when the following refresh fails", async () => {
  const client = new BotClient(connection, async (_url, init) => {
    if (init?.method === "POST") return Response.json({ ok: true });
    throw new Error("Refresh offline");
  });
  await expect(
    client.command({ type: "message", requestId: "saved", text: "Hi" }),
  ).resolves.toEqual({ ok: true });
});
it("does not roll back newer state when an older response arrives late", async () => {
  let finishOld!: (response: Response) => void;
  let calls = 0;
  const client = new BotClient(connection, async () => {
    calls++;
    if (calls === 1)
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    return Response.json(snapshot(2));
  });
  const old = client.refresh();
  await client.refresh();
  finishOld(Response.json(snapshot(1)));
  await old;
  expect(client.getSnapshot().snapshot?.cursor).toBe(2);
});

it("tracks queued, running, retrying, and finished replies without treating background jobs as replies", () => {
  const job = {
    id: "reply",
    kind: "turn",
    state: "pending",
    attempts: 0,
    dueAt: 0,
    error: null,
  } as const;
  expect(getBotReplyActivity([job])).toEqual({ phase: "queued", count: 1 });
  expect(
    getBotReplyActivity([
      { ...job, state: "running" },
      { ...job, id: "next" },
    ]),
  ).toEqual({ phase: "thinking", count: 2 });
  expect(getBotReplyActivity([{ ...job, error: "unavailable" }])).toEqual({
    phase: "retrying",
    count: 1,
  });
  expect(
    getBotReplyActivity([
      { ...job, state: "failed" },
      { ...job, state: "done" },
      { ...job, kind: "memory_review", state: "running" },
    ]),
  ).toEqual({ phase: "idle", count: 0 });
});
