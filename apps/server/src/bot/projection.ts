import type { BotBridgeReport } from "@t3tools/contracts/bot";
import type { OrchestrationV2RunStatus } from "@t3tools/contracts";

export function summarizeBotRun(
  projection: {
    readonly runs: ReadonlyArray<{
      readonly id: string;
      readonly status: OrchestrationV2RunStatus;
      readonly ordinal: number;
    }>;
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly runId: string | null;
      readonly streaming: boolean;
      readonly text: string;
    }>;
  },
  runId: string | null,
): Pick<BotBridgeReport, "runId" | "status" | "result"> {
  const latest = [...projection.runs].sort((a, b) => b.ordinal - a.ordinal)[0];
  const run = (runId ? projection.runs.find((r) => r.id === runId) : undefined) ?? latest;
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
  const result = projection.messages
    .filter((m) => m.role === "assistant" && m.runId === run?.id && !m.streaming)
    .map((m) => m.text)
    .join("\n")
    .slice(-32000);
  return { runId: run?.id ?? null, status, result };
}
