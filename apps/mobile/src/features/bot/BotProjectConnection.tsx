import { useAtomValue } from "@effect/atom-react";
import type { BotClient } from "@t3tools/client-runtime/bot";
import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { botEnvironment } from "../../state/bot";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

const modes: ReadonlyArray<{ value: RuntimeMode; label: string }> = [
  { value: "approval-required", label: "Ask for approvals" },
  { value: "auto-accept-edits", label: "Allow edits" },
  { value: "auto", label: "Automatic" },
  { value: "full-access", label: "Full access" },
];

export function BotProjectConnection({ client }: { client: BotClient }) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [selectedDraft, setSelected] = useState<string[] | null>(null);
  const [modeDraft, setMode] = useState<RuntimeMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configure = useAtomCommand(botEnvironment.configure);
  const canConfigure = useAtomValue(botEnvironment.configure.permissionAtom(environmentId));
  const status = useEnvironmentQuery(
    environmentId && canConfigure ? botEnvironment.connection({ environmentId, input: {} }) : null,
  );
  const current = status.data;
  const selected = selectedDraft ?? current?.projectIds ?? [];
  const mode = modeDraft ?? current?.runtimeMode ?? "approval-required";
  const matches = current?.url === client.connection.url;

  const save = async (disconnect = false) => {
    if (!environmentId) return;
    setBusy(true);
    setError(null);
    let created: string | null = null;
    try {
      if (disconnect) {
        const result = await configure({ environmentId, input: { connection: null } });
        if (result._tag === "Failure") throw new Error("Could not disconnect this environment");
        if (matches && current)
          await client.command({
            type: "environment.revoke",
            requestId: uuidv4(),
            id: current.grantId,
          });
      } else {
        const grant = matches
          ? current
          : await client.command({
              type: "environment.create",
              requestId: uuidv4(),
              name:
                environments.find((e) => e.environmentId === environmentId)?.label ??
                "T3 environment",
            });
        if (!grant || typeof grant !== "object" || !("grantId" in grant || "id" in grant))
          throw new Error("Could not create an environment grant");
        const grantId = "grantId" in grant ? String(grant.grantId) : String(grant.id);
        const token = "token" in grant ? String(grant.token) : undefined;
        if (!matches) created = grantId;
        const result = await configure({
          environmentId,
          input: {
            connection: {
              url: client.connection.url,
              grantId,
              projectIds: selected,
              runtimeMode: mode,
              ...(token ? { token } : {}),
            },
          },
        });
        if (result._tag === "Failure")
          throw new Error("Could not save the destination environment connection");
        created = null;
      }
      status.refresh();
    } catch (cause) {
      if (created)
        await client
          .command({ type: "environment.revoke", requestId: uuidv4(), id: created })
          .catch(() => {});
      setError(cause instanceof Error ? cause.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-2xl border border-separator p-4">
      <AppText>Connect your projects</AppText>
      <AppText textRole="caption">
        Choose an environment, projects and execution permission. The bot URL must be reachable from
        that environment.
      </AppText>
      {environments
        .filter((e) => e.connection.phase === "connected")
        .map((e) => (
          <Button
            key={e.environmentId}
            label={e.label}
            tone={environmentId === e.environmentId ? "primary" : "text"}
            onPress={() => {
              setSelected(null);
              setMode(null);
              setError(null);
              setEnvironmentId(e.environmentId);
            }}
          />
        ))}
      {environmentId && !canConfigure && (
        <AppText textRole="caption">Settings permission is required on this environment.</AppText>
      )}
      {environmentId && canConfigure && (
        <>
          {projects
            .filter((p) => p.environmentId === environmentId && !p.isScratch)
            .map((p) => (
              <Button
                key={p.id}
                label={`${selected.includes(p.id) ? "✓ " : ""}${p.title}`}
                tone="text"
                onPress={() =>
                  setSelected(() =>
                    selected.includes(p.id)
                      ? selected.filter((id) => id !== p.id)
                      : [...selected, p.id],
                  )
                }
              />
            ))}
          <AppText textRole="caption">Execution permission</AppText>
          <View className="flex-row flex-wrap gap-2">
            {modes.map((m) => (
              <Button
                key={m.value}
                label={m.label}
                tone={mode === m.value ? "primary" : "text"}
                onPress={() => setMode(m.value)}
              />
            ))}
          </View>
          <Button
            label={busy ? "Saving…" : matches ? "Save project access" : "Connect environment"}
            disabled={busy || !selected.length || status.isPending}
            onPress={() => void save()}
          />
          {current && (
            <Button
              label="Disconnect environment"
              tone="text"
              disabled={busy}
              onPress={() => void save(true)}
            />
          )}
          <AppText textRole="caption">
            Disconnecting stops new dispatch. Already running workers continue.
          </AppText>
        </>
      )}
      {(error || status.error) && (
        <AppText accessibilityRole="alert">{error ?? status.error}</AppText>
      )}
    </View>
  );
}
