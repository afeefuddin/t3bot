import { BotProjectConnection } from "./BotProjectConnection";
import { BotGoalRow } from "./BotGoalRow";
import { observeResize } from "~/lib/observeResize";
import { randomUUID } from "~/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  BotClient,
  getBotReplyActivity,
  resolveBotThreadTarget,
} from "@t3tools/client-runtime/bot";
import type { BotCommand, BotMemory, BotResponsibility } from "@t3tools/contracts/bot";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { SendIcon, SettingsIcon, ListTodoIcon, BrainIcon, ArrowDownIcon } from "lucide-react";
import { BotComposer, BotMessageRow, BotReplyProgress } from "./BotConversation";
import { BotAvatarDesigner, BotAvatarImage } from "./BotAvatar";
import { useConnectedEnvironmentIds } from "~/state/environments";

const savedKey = "t3bot.connection.v1";
const requestId = randomUUID;
const emptyState = { snapshot: null, connected: false, error: null } as const;
const emptySubscribe = () => () => {};

function MemoryRow({
  memory,
  run,
}: {
  memory: BotMemory;
  run: (command: BotCommand) => Promise<unknown>;
}) {
  const [text, setText] = useState(memory.text);
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">
        {memory.scope} · revision {memory.revision}
      </div>
      <Textarea aria-label="Memory text" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={() =>
            void run({
              type: "memory.save",
              requestId: requestId(),
              id: memory.id,
              revision: memory.revision,
              scope: memory.scope,
              text,
            })
          }
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run({
              type: "memory.forget",
              requestId: requestId(),
              id: memory.id,
              revision: memory.revision,
            })
          }
        >
          Forget
        </Button>
      </div>
    </div>
  );
}

function ResponsibilityRow({
  value,
  run,
}: {
  value: BotResponsibility;
  run: (command: BotCommand) => Promise<unknown>;
}) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <strong>{value.title}</strong>
        <span className="text-xs text-muted-foreground">{value.state}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{value.instructions}</p>
      <p className="text-xs text-muted-foreground">
        {value.schedule.type}
        {value.nextAt ? ` · Next: ${new Date(value.nextAt).toLocaleString()}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={value.state !== "active"}
          onClick={() =>
            void run({ type: "responsibility.run", requestId: requestId(), id: value.id })
          }
        >
          Run now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={value.state === "archived"}
          onClick={() =>
            void run({
              type: "responsibility.state",
              requestId: requestId(),
              id: value.id,
              revision: value.revision,
              state: value.state === "active" ? "paused" : "active",
            })
          }
        >
          {value.state === "active" ? "Pause" : "Resume"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run({
              type: "responsibility.state",
              requestId: requestId(),
              id: value.id,
              revision: value.revision,
              state: value.state === "archived" ? "active" : "archived",
            })
          }
        >
          {value.state === "archived" ? "Restore" : "Archive"}
        </Button>
      </div>
    </div>
  );
}

export function BotPage() {
  const navigate = useNavigate();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const pendingMessage = useRef<{ text: string; id: string } | null>(null);
  const [client, setClient] = useState<BotClient | null>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(savedKey) ?? "null");
      if (
        value &&
        typeof value === "object" &&
        "url" in value &&
        "token" in value &&
        typeof value.url === "string" &&
        typeof value.token === "string"
      )
        return new BotClient({ url: value.url, token: value.token });
    } catch {}
    return null;
  });
  const connection = client?.connection ?? null;
  const [tab, setTab] = useState("chat");
  const [url, setUrl] = useState(connection?.url ?? "");
  const [token, setToken] = useState(connection?.token ?? "");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<{ id: string; token: string } | null>(null);
  const [environmentName, setEnvironmentName] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const scrollSize = useRef("");
  const [showJump, setShowJump] = useState(false);
  useEffect(() => client?.start(), [client]);
  const state = useSyncExternalStore(
    client?.subscribe ?? emptySubscribe,
    client?.getSnapshot ?? (() => emptyState),
  );
  const snapshot = state.snapshot;
  const openThread = (threadId: string, environmentId: string) => {
    try {
      const params = resolveBotThreadTarget(
        { threadId, environmentId },
        snapshot?.environments ?? [],
        connectedEnvironmentIds,
      );
      setError(null);
      void navigate({ to: "/$environmentId/$threadId", params });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open this thread.");
    }
  };
  const lastSeq = snapshot?.messages.at(-1)?.seq;
  const replyActivity = getBotReplyActivity(snapshot?.jobs ?? []);
  const readThrough = snapshot?.readThrough ?? 0;
  useEffect(() => {
    const seq = lastSeq;
    if (client && tab === "chat" && seq && seq > readThrough)
      void client
        .command({ type: "conversation.read", requestId: `read:${seq}`, through: seq })
        .catch(() => {});
  }, [client, tab, lastSeq, readThrough]);
  useEffect(() => {
    const node = scrollContainer.current;
    const content = node?.firstElementChild;
    if (!node || !content || !connection || tab !== "chat") return;
    // Keep the end visible as markdown, the composer, or the viewport changes size.
    return observeResize([node, content], () => {
      if (pinned.current) node.scrollTop = node.scrollHeight;
      scrollSize.current = `${node.clientWidth}:${node.clientHeight}:${node.scrollHeight}`;
    });
  }, [connection, tab]);
  const run = async (command: BotCommand) => {
    if (!client) return;
    setError(null);
    try {
      return await client.command(command);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    }
  };
  const connect = (e: FormEvent) => {
    e.preventDefault();
    try {
      const value = new BotClient({ url, token });
      localStorage.setItem(savedKey, JSON.stringify(value.connection));
      setClient(value);
      setTab("chat");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid connection");
    }
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy || !state.connected || !snapshot?.provider) return;
    setBusy(true);
    pinned.current = true;
    setShowJump(false);
    const value = draft;
    if (pendingMessage.current?.text !== value)
      pendingMessage.current = { text: value, id: requestId() };
    const result = await run({
      type: "message",
      requestId: pendingMessage.current.id,
      text: value,
    });
    if (result) {
      setDraft("");
      pendingMessage.current = null;
    }
    setBusy(false);
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3 pl-8 md:pl-0">
          <BotAvatarImage avatar={snapshot?.avatar} />
          <div>
            <h1 className="font-semibold">t3bot</h1>
            <p className="text-xs text-muted-foreground">
              {state.connected
                ? `Your personal assistant · ${snapshot?.provider || "Connected"}`
                : "Connect your personal bot"}
            </p>
          </div>
        </div>
        <nav className="flex max-w-full flex-wrap gap-1" aria-label="Bot views">
          {[
            { id: "chat", label: "Chat", icon: SendIcon },
            { id: "activity", label: "Activity", icon: ListTodoIcon },
            { id: "memory", label: "Memory", icon: BrainIcon },
            { id: "settings", label: "Settings", icon: SettingsIcon },
          ].map((item) => (
            <Button
              key={item.id}
              variant={tab === item.id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTab(item.id)}
            >
              <item.icon className="hidden size-4 sm:block" />
              {item.label}
              {item.id === "chat" && snapshot?.unread ? ` (${snapshot.unread})` : ""}
            </Button>
          ))}
        </nav>
      </header>
      {(error || state.error) && (
        <div role="alert" className="border-b px-5 py-3 text-sm text-destructive">
          {error ?? state.error}
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void client?.retryPending().catch(() => {})}
            >
              Retry pending requests
            </Button>
          </div>
        </div>
      )}
      <main
        ref={scrollContainer}
        onScroll={(event) => {
          const node = event.currentTarget;
          const size = `${node.clientWidth}:${node.clientHeight}:${node.scrollHeight}`;
          // A layout change can fire scroll before the resize observer; preserve the user's following state.
          if (size !== scrollSize.current && pinned.current) node.scrollTop = node.scrollHeight;
          scrollSize.current = size;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
          setShowJump(!pinned.current);
        }}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-4 py-6 sm:px-6"
      >
        <div className={`mx-auto max-w-3xl ${tab === "chat" ? "space-y-7" : "space-y-4"}`}>
          {!connection || tab === "settings" ? (
            <>
              <h2 className="text-lg font-medium">Connect t3bot</h2>
              <p className="text-sm text-muted-foreground">
                Use your hosted bot URL and its owner credential. The service must allow this
                client’s origin in its configuration.
              </p>
              <form onSubmit={connect} className="space-y-3">
                <label className="block space-y-1 text-sm">
                  <span>Bot URL</span>
                  <Input
                    type="url"
                    value={url}
                    placeholder="https://bot.example.com"
                    onChange={(e) => setUrl(e.target.value)}
                    required
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Owner credential</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                  />
                </label>
                <div className="flex gap-2">
                  <Button type="submit">Connect</Button>
                  {connection && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        localStorage.removeItem(savedKey);
                        setClient(null);
                        setToken("");
                        setGrant(null);
                      }}
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              </form>
              {snapshot && (
                <>
                  {snapshot.avatar && (
                    <BotAvatarDesigner
                      key={JSON.stringify(snapshot.avatar)}
                      avatar={snapshot.avatar}
                      save={async (avatar) =>
                        (await run({ type: "avatar.save", requestId: requestId(), avatar })) !==
                        undefined
                      }
                    />
                  )}
                  <h2 className="pt-4 font-medium">Coordinator</h2>
                  <label className="block space-y-1 text-sm">
                    <span>Provider configuration</span>
                    <select
                      className="w-full rounded-md border bg-background p-2"
                      value={snapshot.provider}
                      onChange={(e) =>
                        void run({
                          type: "settings",
                          requestId: requestId(),
                          provider: e.target.value,
                          autoMemory: snapshot.autoMemory,
                        })
                      }
                    >
                      {snapshot.providers.map((id) => (
                        <option key={id}>{id}</option>
                      ))}
                    </select>
                  </label>
                  {!snapshot.providers.length && (
                    <p className="text-sm text-muted-foreground">
                      Add provider configurations to the hosted bot’s config file, then restart it.
                    </p>
                  )}
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={snapshot.autoMemory}
                      onChange={(e) =>
                        void run({
                          type: "settings",
                          requestId: requestId(),
                          provider: snapshot.provider,
                          autoMemory: e.target.checked,
                        })
                      }
                    />
                    Automatically remember durable preferences
                  </label>
                  <h2 className="pt-4 font-medium">Messaging connections</h2>
                  <p className="text-sm text-muted-foreground">
                    Prompt this bot from Slack or Telegram. Replies and task updates return to the
                    originating chat. Access is limited to the owners configured on the bot server.
                  </p>
                  {!snapshot.connectors?.length && (
                    <p className="text-sm text-muted-foreground">
                      Configure a Slack or Telegram connection on your bot server to get started.
                    </p>
                  )}
                  {snapshot.connectors?.map((connector) => (
                    <div key={connector.id} className="space-y-2 rounded-lg border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong>{connector.name}</strong>
                        <span className="text-xs text-muted-foreground">
                          {connector.type} · {connector.enabled ? "enabled" : "paused"}
                        </span>
                      </div>
                      <p className="text-sm">
                        {connector.pending} pending replies · {connector.failed} failed
                      </p>
                      {connector.lastError && (
                        <p className="text-sm text-destructive">
                          Delivery: {connector.lastError}. Review failed deliveries in Activity.
                        </p>
                      )}
                      <code className="block break-all text-xs">
                        {connection?.url}/connectors/{connector.id}
                      </code>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void run({
                            type: "connector.state",
                            requestId: requestId(),
                            id: connector.id,
                            enabled: !connector.enabled,
                          })
                        }
                      >
                        {connector.enabled ? "Pause connection" : "Resume connection"}
                      </Button>
                    </div>
                  ))}
                  {client && <BotProjectConnection client={client} />}
                  <h2 className="pt-4 font-medium">Pair another server manually</h2>
                  <div className="flex gap-2">
                    <Input
                      aria-label="Environment name"
                      placeholder="My laptop or cloud workspace"
                      value={environmentName}
                      onChange={(e) => setEnvironmentName(e.target.value)}
                    />
                    <Button
                      disabled={!environmentName.trim()}
                      onClick={() => {
                        void run({
                          type: "environment.create",
                          requestId: requestId(),
                          name: environmentName,
                        }).then((value) => {
                          if (
                            value &&
                            typeof value === "object" &&
                            "id" in value &&
                            "token" in value
                          )
                            setGrant({ id: String(value.id), token: String(value.token) });
                        });
                      }}
                    >
                      Pair
                    </Button>
                  </div>
                  {grant && (
                    <div className="space-y-2 rounded-lg border p-4">
                      <p className="text-sm">
                        Configure these on the destination T3 server, plus its allowed project IDs
                        and execution mode:
                      </p>
                      <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{`T3BOT_URL=${connection?.url}\nT3BOT_BRIDGE_ID=${grant.id}\nT3BOT_BRIDGE_TOKEN=${grant.token}`}</pre>
                      <Button variant="ghost" size="sm" onClick={() => setGrant(null)}>
                        Hide credential
                      </Button>
                    </div>
                  )}
                  {snapshot.environments.map((env) => (
                    <div
                      className="flex items-center justify-between gap-3 rounded-lg border p-3"
                      key={env.id}
                    >
                      <div>
                        <strong className="text-sm">{env.name}</strong>
                        <p className="text-xs text-muted-foreground">
                          {env.revoked
                            ? "Access revoked"
                            : env.lastSeen
                              ? `Last seen ${new Date(env.lastSeen).toLocaleString()} · ${env.projects.length} projects`
                              : "Waiting for pairing"}
                        </p>
                      </div>
                      {!env.revoked && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void run({
                              type: "environment.revoke",
                              requestId: requestId(),
                              id: env.id,
                            })
                          }
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          ) : tab === "chat" ? (
            <>
              {!!snapshot?.messages.length && snapshot.messages[0]!.seq > 1 && (
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => void client?.older().catch((cause) => setError(String(cause)))}
                  >
                    Load earlier messages
                  </Button>
                </div>
              )}
              {!snapshot ? (
                <p role="status" className="py-10 text-sm text-muted-foreground">
                  Loading your conversation…
                </p>
              ) : !snapshot.messages.length ? (
                <div className="flex flex-col items-center gap-4 py-16 text-center sm:py-24">
                  <BotAvatarImage avatar={snapshot.avatar} size={64} />
                  <div className="space-y-2">
                    <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
                      A little help. A lot off your plate.
                    </h2>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                      Think out loud, hand off a task, or ask me to remember something.
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {[
                      "What can you help me with?",
                      "Help me plan a task",
                      "What needs my attention?",
                    ].map((prompt) => (
                      <Button
                        key={prompt}
                        variant="outline"
                        size="sm"
                        onClick={() => setDraft(prompt)}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : (
                snapshot.messages.map((message) => (
                  <BotMessageRow key={message.id} message={message} avatar={snapshot.avatar} />
                ))
              )}
              <BotReplyProgress
                activity={replyActivity}
                sending={busy}
                connected={state.connected}
                avatar={snapshot?.avatar}
              />
              <div ref={bottom} />
            </>
          ) : tab === "memory" ? (
            <>
              <h2 className="font-medium">What t3bot remembers</h2>
              <p className="text-sm text-muted-foreground">
                Correct a note or forget it. You can also ask t3bot to remember something in chat.
              </p>
              {!snapshot?.memories.length && (
                <p className="text-sm text-muted-foreground">No saved memories yet.</p>
              )}
              {snapshot?.memories.map((memory) => (
                <MemoryRow key={`${memory.id}:${memory.revision}`} memory={memory} run={run} />
              ))}
            </>
          ) : (
            <>
              <h2 className="font-medium">Goals</h2>
              <p className="text-sm text-muted-foreground">
                Ask t3bot to investigate or fix a problem in a connected project. It will save
                completion criteria and verify the work before closing the goal.
              </p>
              {!snapshot?.goals?.length && (
                <p className="text-sm text-muted-foreground">Project goals will appear here.</p>
              )}
              {snapshot?.goals?.map((goal) => (
                <BotGoalRow
                  key={goal.id}
                  goal={goal}
                  tasks={snapshot.tasks}
                  run={run}
                  openThread={openThread}
                />
              ))}
              <h2 className="pt-3 font-medium">Responsibilities</h2>
              <p className="text-sm text-muted-foreground">
                Create or edit ongoing responsibilities in chat—for example, “Every weekday at 9 in
                Asia/Kolkata, review my active work.”
              </p>
              {snapshot?.responsibilities.map((r) => (
                <ResponsibilityRow key={r.id} value={r} run={run} />
              ))}
              <h2 className="pt-3 font-medium">Tasks</h2>
              {!snapshot?.tasks.length && (
                <p className="text-sm text-muted-foreground">Delegated work will appear here.</p>
              )}
              {snapshot?.tasks.map((task) => (
                <div key={task.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex justify-between gap-3">
                    <strong>{task.title}</strong>
                    <span className="text-xs text-muted-foreground">
                      {task.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {snapshot.environments.find((e) => e.id === task.environmentId)?.name ??
                      task.environmentId}
                  </p>
                  {task.result && <p className="whitespace-pre-wrap text-sm">{task.result}</p>}
                  <div className="flex gap-2">
                    {task.threadId && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (task.threadId) openThread(task.threadId, task.environmentId);
                        }}
                      >
                        Open thread
                      </Button>
                    )}
                    {!["completed", "failed", "cancelled"].includes(task.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run({ type: "task.cancel", requestId: requestId(), id: task.id })
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <h2 className="pt-3 font-medium">Background jobs</h2>
              {snapshot?.jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <div>
                    <p className="text-sm">
                      {job.kind} · {job.state}
                    </p>
                    {job.error && (
                      <p className="text-xs text-muted-foreground">
                        {job.error} · {job.attempts} attempts
                      </p>
                    )}
                  </div>
                  {job.state === "failed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void run({ type: "job.retry", requestId: requestId(), id: job.id })
                      }
                    >
                      Retry
                    </Button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </main>
      {connection && tab === "chat" && (
        <div className="shrink-0 px-4 pt-2 pb-3 sm:px-6 sm:pb-4">
          {showJump && (
            <div className="mb-3 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  pinned.current = true;
                  setShowJump(false);
                  bottom.current?.scrollIntoView({ block: "nearest" });
                }}
              >
                <ArrowDownIcon className="size-3.5" /> Latest messages
              </Button>
            </div>
          )}
          <BotComposer
            draft={draft}
            setDraft={setDraft}
            send={send}
            sending={busy}
            connected={state.connected}
            provider={snapshot?.provider ?? ""}
            onProviderClick={() => setTab("settings")}
          />
        </div>
      )}
    </div>
  );
}
