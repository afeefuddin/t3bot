import { BotProjectConnection } from "./BotProjectConnection";
import { uuidv4 } from "../../lib/uuid";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import * as SecureStore from "expo-secure-store";
import { BotClient, getBotReplyActivity, type BotConnection } from "@t3tools/client-runtime/bot";
import type { BotCommand, BotMemory } from "@t3tools/contracts/bot";
import { BotAvatarDesigner, BotAvatarImage } from "./BotAvatar";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SettingsScreen } from "../settings/components/SettingsScreen";

const connectionKey = "t3bot.connection.v1";
const emptyState = { snapshot: null, connected: false, error: null } as const;
const emptySubscribe = () => () => {};
const id = uuidv4;

function MemoryEditor({
  memory,
  run,
}: {
  memory: BotMemory;
  run: (input: BotCommand) => Promise<unknown>;
}) {
  const [value, setValue] = useState(memory.text);
  return (
    <View className="gap-2 rounded-2xl border border-separator p-4">
      <AppText textRole="caption">{memory.scope}</AppText>
      <AppTextInput
        accessibilityLabel="Memory text"
        multiline
        value={value}
        onChangeText={setValue}
      />
      <View className="flex-row gap-2">
        <Button
          label="Save"
          disabled={!value.trim()}
          onPress={() => {
            void run({
              type: "memory.save",
              requestId: id(),
              id: memory.id,
              revision: memory.revision,
              scope: memory.scope,
              text: value,
            });
          }}
        />
        <Button
          label="Forget"
          tone="text"
          onPress={() => {
            void run({
              type: "memory.forget",
              requestId: id(),
              id: memory.id,
              revision: memory.revision,
            });
          }}
        />
      </View>
    </View>
  );
}

export function BotRouteScreen() {
  const navigation = useNavigation();
  const [client, setClient] = useState<BotClient | null>(null);
  const [tab, setTab] = useState("Chat");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [grant, setGrant] = useState<string | null>(null);
  const pendingMessage = useRef<{ text: string; id: string } | null>(null);
  const state = useSyncExternalStore(
    client?.subscribe ?? emptySubscribe,
    client?.getSnapshot ?? (() => emptyState),
  );
  const snapshot = state.snapshot;
  const lastSeq = snapshot?.messages.at(-1)?.seq;
  const replyActivity = getBotReplyActivity(snapshot?.jobs ?? []);
  const readThrough = snapshot?.readThrough ?? 0;
  useEffect(() => {
    const seq = lastSeq;
    if (client && tab === "Chat" && seq && seq > readThrough)
      void client
        .command({ type: "conversation.read", requestId: `read:${seq}`, through: seq })
        .catch(() => {});
  }, [client, tab, lastSeq, readThrough]);
  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(connectionKey)
      .then((raw) => {
        if (!raw || !active) return;
        try {
          const connection = JSON.parse(raw) as BotConnection;
          const next = new BotClient(connection);
          setUrl(connection.url);
          setToken(connection.token);
          setClient(next);
        } catch {
          setError("Saved bot connection is invalid. Reconnect in Settings.");
        }
      })
      .catch(() => setError("Could not read the saved bot connection"));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => client?.start(), [client]);
  const run = async (input: BotCommand) => {
    if (!client) return;
    setError(null);
    try {
      return await client.command(input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    }
  };
  const connect = async () => {
    try {
      const next = new BotClient({ url, token });
      await SecureStore.setItemAsync(connectionKey, JSON.stringify(next.connection));
      setClient(next);
      setTab("Chat");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection failed");
    }
  };
  const send = async () => {
    if (!draft.trim() || busy || !state.connected || !snapshot?.provider) return;
    setBusy(true);
    if (pendingMessage.current?.text !== draft) pendingMessage.current = { text: draft, id: id() };
    const result = await run({
      type: "message",
      requestId: pendingMessage.current.id,
      text: draft,
    });
    if (result) {
      setDraft("");
      pendingMessage.current = null;
    }
    setBusy(false);
  };
  return (
    <SettingsScreen title="t3bot">
      <View className="flex-1 gap-3">
        <ScrollView horizontal className="max-h-14" contentContainerClassName="gap-2 py-1">
          {["Chat", "Activity", "Memory", "Settings"].map((value) => (
            <Button
              key={value}
              label={value}
              tone={tab === value ? "primary" : "text"}
              onPress={() => setTab(value)}
            />
          ))}
        </ScrollView>
        <View className="flex-row items-center gap-2">
          <BotAvatarImage avatar={snapshot?.avatar} />
          <AppText textRole="caption">
            {state.connected
              ? "Connected · background work continues when you leave"
              : "Disconnected"}
          </AppText>
        </View>
        {(error || state.error) && (
          <AppText accessibilityRole="alert">{error ?? state.error}</AppText>
        )}
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-4 pb-6"
        >
          {!client || tab === "Settings" ? (
            <>
              <AppText>Connect your hosted bot using its URL and owner credential.</AppText>
              <AppTextInput
                accessibilityLabel="Bot URL"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://bot.example.com"
                value={url}
                onChangeText={setUrl}
              />
              <AppTextInput
                accessibilityLabel="Owner credential"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder="Owner credential"
                value={token}
                onChangeText={setToken}
              />
              <Button
                label="Connect"
                onPress={() => {
                  void connect();
                }}
              />
              {client && (
                <Button
                  label="Disconnect"
                  tone="text"
                  onPress={() => {
                    void SecureStore.deleteItemAsync(connectionKey)
                      .then(() => {
                        client.stop();
                        setClient(null);
                        setToken("");
                        setGrant(null);
                      })
                      .catch(() => setError("Could not remove the saved connection"));
                  }}
                />
              )}
              {snapshot && (
                <>
                  {snapshot.avatar && (
                    <BotAvatarDesigner
                      key={JSON.stringify(snapshot.avatar)}
                      avatar={snapshot.avatar}
                      save={async (avatar) =>
                        (await run({ type: "avatar.save", requestId: id(), avatar })) !== undefined
                      }
                    />
                  )}
                  <AppText>Coordinator provider</AppText>
                  {snapshot.providers.map((provider) => (
                    <Button
                      key={provider}
                      label={`${provider}${snapshot.provider === provider ? " · selected" : ""}`}
                      onPress={() => {
                        void run({
                          type: "settings",
                          requestId: id(),
                          provider,
                          autoMemory: snapshot.autoMemory,
                        });
                      }}
                    />
                  ))}
                  <Button
                    label={
                      snapshot.autoMemory ? "Disable automatic memory" : "Enable automatic memory"
                    }
                    onPress={() => {
                      void run({
                        type: "settings",
                        requestId: id(),
                        provider: snapshot.provider,
                        autoMemory: !snapshot.autoMemory,
                      });
                    }}
                  />
                  <AppText>Messaging connections</AppText>
                  <AppText textRole="caption">
                    Prompt this bot from Slack or Telegram. Replies return to the originating chat.
                  </AppText>
                  {!snapshot.connectors?.length && (
                    <AppText textRole="caption">Configure connections on your bot server.</AppText>
                  )}
                  {snapshot.connectors?.map((connector) => (
                    <View
                      key={connector.id}
                      className="gap-2 rounded-2xl border border-separator p-4"
                    >
                      <AppText>
                        {connector.name} · {connector.enabled ? "enabled" : "paused"}
                      </AppText>
                      <AppText textRole="caption">
                        {connector.type} · {connector.pending} pending · {connector.failed} failed
                      </AppText>
                      {connector.lastError && (
                        <AppText>Delivery: {connector.lastError}. Review Activity.</AppText>
                      )}
                      <AppText selectable textRole="caption">
                        {url}/connectors/{connector.id}
                      </AppText>
                      <Button
                        label={connector.enabled ? "Pause connection" : "Resume connection"}
                        onPress={() => {
                          void run({
                            type: "connector.state",
                            requestId: id(),
                            id: connector.id,
                            enabled: !connector.enabled,
                          });
                        }}
                      />
                    </View>
                  ))}
                  {client && <BotProjectConnection client={client} />}
                  <AppText>Pair another server manually</AppText>
                  <AppTextInput
                    accessibilityLabel="Environment name"
                    placeholder="Laptop or cloud workspace"
                    value={name}
                    onChangeText={setName}
                  />
                  <Button
                    label="Pair environment"
                    disabled={!name.trim()}
                    onPress={() => {
                      void run({ type: "environment.create", requestId: id(), name }).then(
                        (value) => {
                          if (
                            value &&
                            typeof value === "object" &&
                            "id" in value &&
                            "token" in value
                          )
                            setGrant(
                              `T3BOT_URL=${url}\nT3BOT_BRIDGE_ID=${String(value.id)}\nT3BOT_BRIDGE_TOKEN=${String(value.token)}`,
                            );
                        },
                      );
                    }}
                  />
                  {grant && (
                    <>
                      <AppText selectable>{grant}</AppText>
                      <Button label="Hide credential" tone="text" onPress={() => setGrant(null)} />
                    </>
                  )}
                  {snapshot.environments.map((env) => (
                    <View key={env.id} className="gap-2">
                      <AppText>
                        {env.name} · {env.revoked ? "revoked" : env.lastSeen ? "paired" : "waiting"}
                      </AppText>
                      {!env.revoked && (
                        <Button
                          label="Revoke access"
                          tone="text"
                          onPress={() => {
                            void run({ type: "environment.revoke", requestId: id(), id: env.id });
                          }}
                        />
                      )}
                    </View>
                  ))}
                </>
              )}
            </>
          ) : tab === "Memory" ? (
            <>
              <AppText>
                Edit or forget saved notes. Ask t3bot to remember new preferences in chat.
              </AppText>
              {snapshot?.memories.map((memory) => (
                <MemoryEditor key={`${memory.id}:${memory.revision}`} memory={memory} run={run} />
              ))}
            </>
          ) : tab === "Activity" ? (
            <>
              <AppText>Goals</AppText>
              <AppText textRole="caption">
                Ask t3bot to fix a problem in a connected project. It saves criteria and verifies
                the work before completion.
              </AppText>
              {snapshot?.goals?.map((goal) => (
                <View key={goal.id} className="gap-2 rounded-2xl border border-separator p-4">
                  <AppText>
                    {goal.title} · {goal.state}
                  </AppText>
                  <AppText>{goal.objective}</AppText>
                  {goal.criteria.map((criterion, index) => (
                    <View key={criterion}>
                      <AppText>
                        {index + 1}. {criterion}
                      </AppText>
                      {goal.evidence
                        .filter((e) => e.criterion === index)
                        .map((e) => (
                          <AppText key={e.criterion} textRole="caption">
                            {e.quote}
                          </AppText>
                        ))}
                    </View>
                  ))}
                  {!!goal.reason && <AppText>{goal.reason}</AppText>}
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      label={
                        ["active", "verifying"].includes(goal.state)
                          ? "Pause"
                          : ["completed", "cancelled"].includes(goal.state)
                            ? "Reopen"
                            : "Resume"
                      }
                      onPress={() =>
                        void run({
                          type: "goal.state",
                          requestId: id(),
                          id: goal.id,
                          revision: goal.revision,
                          state: ["active", "verifying"].includes(goal.state) ? "paused" : "active",
                          reason: "Owner changed goal state",
                        })
                      }
                    />
                    {!["completed", "cancelled"].includes(goal.state) && (
                      <Button
                        label="Cancel goal"
                        tone="text"
                        onPress={() =>
                          void run({
                            type: "goal.state",
                            requestId: id(),
                            id: goal.id,
                            revision: goal.revision,
                            state: "cancelled",
                            reason: "Owner cancelled goal",
                          })
                        }
                      />
                    )}
                  </View>
                  <AppText textRole="caption">
                    {goal.rounds}/{goal.roundLimit ?? 24} worker turns. Cancel running tasks
                    separately.
                  </AppText>
                </View>
              ))}
              <AppText>Responsibilities</AppText>
              <AppText textRole="caption">Create or edit a responsibility in chat.</AppText>
              {snapshot?.responsibilities.map((r) => (
                <View key={r.id} className="gap-2 rounded-2xl border border-separator p-4">
                  <AppText>
                    {r.title} · {r.state}
                  </AppText>
                  <AppText>{r.instructions}</AppText>
                  {r.nextAt !== null && (
                    <AppText textRole="caption">
                      Next: {new Date(r.nextAt).toLocaleString()}
                    </AppText>
                  )}
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      label="Run now"
                      disabled={r.state !== "active"}
                      onPress={() => {
                        void run({ type: "responsibility.run", requestId: id(), id: r.id });
                      }}
                    />
                    <Button
                      label={r.state === "active" ? "Pause" : "Resume"}
                      onPress={() => {
                        void run({
                          type: "responsibility.state",
                          requestId: id(),
                          id: r.id,
                          revision: r.revision,
                          state: r.state === "active" ? "paused" : "active",
                        });
                      }}
                    />
                    <Button
                      label={r.state === "archived" ? "Restore" : "Archive"}
                      tone="text"
                      onPress={() => {
                        void run({
                          type: "responsibility.state",
                          requestId: id(),
                          id: r.id,
                          revision: r.revision,
                          state: r.state === "archived" ? "active" : "archived",
                        });
                      }}
                    />
                  </View>
                </View>
              ))}
              <AppText>Tasks</AppText>
              {snapshot?.tasks.map((task) => (
                <View key={task.id} className="gap-2 rounded-2xl border border-separator p-4">
                  <AppText>
                    {task.title} · {task.status.replaceAll("_", " ")}
                  </AppText>
                  <AppText>{task.result}</AppText>
                  {task.threadId && (
                    <Button
                      label="Open thread"
                      tone="text"
                      onPress={() => {
                        const identity = snapshot.environments.find(
                          (env) => env.id === task.environmentId,
                        )?.identity;
                        if (identity)
                          navigation.dispatch(
                            CommonActions.navigate("Thread", {
                              environmentId: identity,
                              threadId: task.threadId,
                            }),
                          );
                      }}
                    />
                  )}
                  {!["completed", "cancelled", "failed"].includes(task.status) && (
                    <Button
                      label="Cancel"
                      tone="text"
                      onPress={() => {
                        void run({ type: "task.cancel", requestId: id(), id: task.id });
                      }}
                    />
                  )}
                </View>
              ))}
              {snapshot?.jobs
                .filter((j) => j.state === "failed")
                .map((job) => (
                  <View key={job.id} className="gap-2">
                    <AppText>
                      {job.kind} failed: {job.error}
                    </AppText>
                    <Button
                      label="Retry job"
                      onPress={() => {
                        void run({ type: "job.retry", requestId: id(), id: job.id });
                      }}
                    />
                  </View>
                ))}
            </>
          ) : (
            <>
              <Button
                label="Load earlier messages"
                tone="text"
                onPress={() => {
                  void client.older().catch(() => setError("Could not load earlier messages"));
                }}
              />
              {!snapshot?.messages.length && <AppText>What should I take care of?</AppText>}
              {snapshot?.messages.map((message) => (
                <View
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "ml-8 gap-2 self-end rounded-2xl bg-subtle p-4"
                      : "gap-2 py-2"
                  }
                >
                  <View className="flex-row items-center gap-2">
                    {message.role === "assistant" && (
                      <BotAvatarImage avatar={snapshot.avatar} size={24} />
                    )}
                    <AppText textRole="caption">
                      {message.role === "user"
                        ? "You"
                        : message.role === "assistant"
                          ? "t3bot"
                          : "Activity"}
                    </AppText>
                  </View>
                  <AppText selectable>{message.text}</AppText>
                </View>
              ))}
            </>
          )}
        </ScrollView>
        {client && tab === "Chat" && (
          <View className="gap-3">
            {(busy || replyActivity.phase !== "idle") && (
              <View className="flex-row items-center gap-2" accessibilityLiveRegion="polite">
                <BotAvatarImage avatar={snapshot?.avatar} size={24} />
                <AppActivityIndicator size="small" />
                <AppText textRole="caption">
                  {!state.connected
                    ? "Reconnecting…"
                    : busy
                      ? "Sending…"
                      : replyActivity.phase === "thinking"
                        ? "Thinking…"
                        : replyActivity.phase === "retrying"
                          ? "Waiting to retry…"
                          : "Message queued…"}
                  {replyActivity.count > 1 ? ` · ${replyActivity.count - 1} queued` : ""}
                </AppText>
              </View>
            )}
            <View className="gap-2 rounded-2xl border border-separator bg-subtle p-2">
              <AppTextInput
                className="max-h-40 border-0 bg-transparent"
                editable={!busy}
                accessibilityLabel="Message t3bot"
                multiline
                placeholder="Ask t3bot…"
                value={draft}
                onChangeText={setDraft}
              />
              <View className="flex-row items-center justify-between gap-2 px-2 pb-1">
                <AppText textRole="caption">
                  {snapshot?.provider || "Choose a provider in Settings"}
                </AppText>
                <Button
                  label={busy ? "Sending…" : "Send"}
                  loading={busy}
                  tone="primary"
                  disabled={!draft.trim() || busy || !state.connected || !snapshot?.provider}
                  onPress={() => {
                    void send();
                  }}
                />
                {state.error && (
                  <Button
                    label="Retry pending"
                    tone="text"
                    onPress={() => {
                      void client.retryPending().catch(() => {});
                    }}
                  />
                )}
              </View>
            </View>
          </View>
        )}
      </View>
    </SettingsScreen>
  );
}
