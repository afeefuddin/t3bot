import { BOT_MAX_VERIFICATION_CHECKS, type BotBridgeReport } from "@t3tools/contracts/bot";
import { stableId } from "@t3tools/shared/stableId";
import type { OrchestrationV2RunStatus, OrchestrationV2TurnItem } from "@t3tools/contracts";

export function summarizeBotRun(
  projection: {
    readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly runs: ReadonlyArray<{
      readonly id: string;
      readonly status: OrchestrationV2RunStatus;
      readonly ordinal: number;
      readonly activeAttemptId?: string | null;
    }>;
    readonly providerTurns?: ReadonlyArray<{
      readonly id: string;
      readonly runAttemptId: string | null;
    }>;
    readonly runtimeRequests?: ReadonlyArray<{
      readonly status: string;
      readonly kind: string;
      readonly providerTurnId: string | null;
    }>;
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly runId: string | null;
      readonly streaming: boolean;
      readonly text: string;
    }>;
  },
  runId: string | null,
  collectChecks = false,
): Pick<BotBridgeReport, "runId" | "status" | "result" | "checks"> {
  const latest = [...projection.runs].sort((a, b) => b.ordinal - a.ordinal)[0];
  const run = runId ? projection.runs.find((r) => r.id === runId) : latest;
  let status: BotBridgeReport["status"] = "accepted";
  switch (run?.status) {
    case "running":
      status = "running";
      break;
    case "waiting":
      status = "waiting_input";
      break;
    case "completed":
      status = "completed";
      break;
    case "failed":
    case "rolled_back":
      status = "failed";
      break;
    case "cancelled":
    case "interrupted":
      status = "cancelled";
      break;
  }
  let result = projection.messages
    .filter((m) => m.role === "assistant" && m.runId === run?.id && !m.streaming)
    .map((m) => m.text)
    .join("\n")
    .slice(-32000);
  const blockingAttempts = new Set(
    projection.runs
      .filter(
        (candidate) =>
          candidate.id === run?.id || (run?.status === "queued" && candidate.ordinal < run.ordinal),
      )
      .filter((candidate) => ["running", "starting", "waiting"].includes(candidate.status))
      .flatMap((candidate) => (candidate.activeAttemptId ? [candidate.activeAttemptId] : [])),
  );
  const blockingTurns = new Set(
    (projection.providerTurns ?? [])
      .filter((turn) => turn.runAttemptId !== null && blockingAttempts.has(turn.runAttemptId))
      .map((turn) => turn.id),
  );
  const pending = projection.runtimeRequests?.find(
    (request) =>
      request.status === "pending" &&
      request.providerTurnId !== null &&
      blockingTurns.has(request.providerTurnId),
  );
  if (pending) {
    status = "waiting_input";
    const reason =
      pending.kind === "command"
        ? "command approval"
        : pending.kind === "user_input"
          ? "user input"
          : "provider approval or authentication";
    result = `Waiting for ${reason}. Open this T3 thread to respond; sending a follow-up cannot approve the request.${result ? `\n${result}` : ""}`;
  }
  const checks =
    run && collectChecks && status === "completed"
      ? (projection.turnItems ?? [])
          .filter((item) => item.type === "command_execution")
          .filter((item) => item.runId === run.id)
          .sort((a, b) => a.ordinal - b.ordinal)
          .slice(-BOT_MAX_VERIFICATION_CHECKS)
          .map((item) => ({
            id: stableId("verification-check", item.id),
            runId: run.id,
            command: item.input.slice(0, 2048),
            output: (item.output ?? "").slice(-1500),
            exitCode: item.exitCode ?? null,
            outcome:
              item.exitCode === 0 && item.status === "completed" && !item.outputIndicatesFailure
                ? ("passed" as const)
                : item.outputIndicatesFailure ||
                    item.status === "failed" ||
                    (item.exitCode !== undefined && item.exitCode !== 0)
                  ? ("failed" as const)
                  : ("unknown" as const),
          }))
      : [];
  return { runId: run?.id ?? null, status, result, checks };
}
