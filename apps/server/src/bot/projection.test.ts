import { expect, it } from "vite-plus/test";
import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import { BOT_MAX_VERIFICATION_CHECKS } from "@t3tools/contracts/bot";
import * as Schema from "effect/Schema";
import { summarizeBotRun } from "./projection.ts";

it("tracks the specified run instead of substituting a different completed result", () => {
  const projection = {
    runs: [
      { id: "old", status: "completed" as const, ordinal: 1 },
      { id: "new", status: "running" as const, ordinal: 2 },
    ],
    messages: [
      { role: "assistant", runId: "old", streaming: false, text: "Old completion" },
      { role: "assistant", runId: "new", streaming: true, text: "Partial" },
    ],
  };
  expect(summarizeBotRun(projection, "new")).toEqual({
    runId: "new",
    status: "running",
    result: "",
    checks: [],
  });
});
it("uses run ordinal rather than array position and returns finalized output only", () => {
  expect(
    summarizeBotRun(
      {
        runs: [
          { id: "new", status: "completed", ordinal: 2 },
          { id: "old", status: "completed", ordinal: 1 },
        ],
        messages: [{ role: "assistant", runId: "new", streaming: false, text: "Final" }],
      },
      null,
    ),
  ).toEqual({ runId: "new", status: "completed", result: "Final", checks: [] });
});
it("reports a waiting run as input-required without claiming completion", () => {
  expect(
    summarizeBotRun({ runs: [{ id: "run", status: "waiting", ordinal: 1 }], messages: [] }, "run")
      .status,
  ).toBe("waiting_input");
});

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const commandItem = (overrides: Record<string, unknown> = {}) =>
  decodeItem({
    id: "command",
    threadId: "thread",
    runId: "verify",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    type: "command_execution",
    status: "completed",
    title: null,
    input: "node --test",
    output: "3 passed",
    exitCode: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...overrides,
  });
it("derives bounded checks from the selected run's command events, not assistant claims", () => {
  const report = summarizeBotRun(
    {
      runs: [{ id: "verify", status: "completed", ordinal: 2 }],
      messages: [
        { role: "assistant", runId: "verify", streaming: false, text: "PASS 1: all good" },
      ],
      turnItems: [
        commandItem(),
        commandItem({ id: "failed", ordinal: 1, exitCode: 1, status: "failed" }),
        commandItem({ id: "unknown", ordinal: 2, exitCode: undefined }),
        commandItem({ id: "flagged", ordinal: 3, outputIndicatesFailure: true }),
        commandItem({ id: "running", ordinal: 4, status: "running" }),
        commandItem({ id: "old", runId: "implementation" }),
      ],
    },
    "verify",
    true,
  );
  expect(report.checks?.map((c) => c.outcome)).toEqual([
    "passed",
    "failed",
    "unknown",
    "failed",
    "unknown",
  ]);
  expect(report.checks?.[0]).toMatchObject({
    command: "node --test",
    output: "3 passed",
    exitCode: 0,
    runId: "verify",
  });
  expect(report.checks).toHaveLength(5);
});
it("never substitutes another run's passing evidence when the requested run is missing", () => {
  const report = summarizeBotRun(
    {
      runs: [{ id: "other", status: "completed", ordinal: 1 }],
      messages: [
        { role: "assistant", runId: "other", streaming: false, text: "PASS 1: tests pass" },
      ],
      turnItems: [commandItem({ runId: "other" })],
    },
    "missing",
    true,
  );
  expect(report).toEqual({ runId: null, status: "accepted", result: "", checks: [] });
});
it("bounds receipt count and command/output text while keeping IDs stable across polls", () => {
  const projection = {
    runs: [{ id: "verify", status: "completed" as const, ordinal: 1 }],
    messages: [],
    turnItems: Array.from({ length: BOT_MAX_VERIFICATION_CHECKS + 1 }, (_, index) =>
      commandItem({
        id: `check-${index}`,
        ordinal: index,
        input: "x".repeat(3000),
        output: "y".repeat(3000),
      }),
    ),
  };
  const report = summarizeBotRun(projection, "verify", true);
  expect(report.checks).toHaveLength(BOT_MAX_VERIFICATION_CHECKS);
  expect(report.checks?.[0]?.command).toHaveLength(2048);
  expect(report.checks?.[0]?.output).toHaveLength(1500);
  expect(report.checks).toEqual(summarizeBotRun(projection, "verify", true).checks);
});
