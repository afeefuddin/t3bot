import { useAtomValue } from "@effect/atom-react";
import type { BotClient } from "@t3tools/client-runtime/bot";
import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { botEnvironment } from "~/state/bot";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";

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
  const save = async () => {
    if (!environmentId || !selected.length) return;
    setBusy(true);
    setError(null);
    let created: string | null = null;
    try {
      const grant = matches
        ? current
        : await client.command({
            type: "environment.create",
            requestId: randomUUID(),
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
        throw new Error(
          "The destination environment could not save this connection. Check its settings permission and connection.",
        );
      created = null;
      status.refresh();
    } catch (cause) {
      if (created)
        await client
          .command({ type: "environment.revoke", requestId: randomUUID(), id: created })
          .catch(() => {});
      setError(cause instanceof Error ? cause.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!environmentId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await configure({ environmentId, input: { connection: null } });
      if (result._tag === "Failure") throw new Error("Could not disconnect this environment");
      if (matches && current)
        await client.command({
          type: "environment.revoke",
          requestId: randomUUID(),
          id: current.grantId,
        });
      status.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="font-medium">Connect your projects</h2>
      <p className="text-sm text-muted-foreground">
        Choose a T3 environment and the projects this bot can read and work on. The bot URL must be
        reachable from that environment.
      </p>
      <label className="block space-y-1 text-sm">
        <span>T3 environment</span>
        <select
          aria-label="T3 environment"
          className="w-full rounded-md border bg-background p-2"
          value={environmentId ?? ""}
          onChange={(e) => {
            setSelected(null);
            setMode(null);
            setError(null);
            setEnvironmentId(
              environments.find((env) => env.environmentId === e.target.value)?.environmentId ??
                null,
            );
          }}
        >
          <option value="">Choose an environment</option>
          {environments
            .filter((e) => e.connection.phase === "connected")
            .map((e) => (
              <option key={e.environmentId} value={e.environmentId}>
                {e.label}
              </option>
            ))}
        </select>
      </label>
      {environmentId && !canConfigure && (
        <p className="text-sm text-muted-foreground">
          This connection needs permission to change environment settings.
        </p>
      )}
      {environmentId && canConfigure && (
        <>
          {projects
            .filter((p) => p.environmentId === environmentId && !p.isScratch)
            .map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={(e) =>
                    setSelected(() =>
                      e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id),
                    )
                  }
                />
                {p.title}
              </label>
            ))}
          <label className="block space-y-1 text-sm">
            <span>Execution permission</span>
            <select
              aria-label="Execution permission"
              className="w-full rounded-md border bg-background p-2"
              value={mode}
              onChange={(e) => setMode(e.target.value as RuntimeMode)}
            >
              <option value="approval-required">Ask for approvals</option>
              <option value="auto-accept-edits">Allow edits</option>
              <option value="auto">Automatic</option>
              <option value="full-access">Full access</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            {matches
              ? "Connected. Save to update project access."
              : current
                ? "This environment is connected to another bot. Connecting will replace that connection."
                : "Connect once; the T3 server remembers this grant across restarts."}{" "}
            Disconnecting stops new dispatch; running workers continue.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !selected.length || status.isPending}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : matches ? "Save project access" : "Connect environment"}
            </Button>
            {current && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect()}>
                Disconnect environment
              </Button>
            )}
          </div>
        </>
      )}
      {(error || status.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? status.error}
        </p>
      )}
    </section>
  );
}
