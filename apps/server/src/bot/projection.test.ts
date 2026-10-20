import { expect, it } from "vite-plus/test";
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
  ).toEqual({ runId: "new", status: "completed", result: "Final" });
});
it("reports a waiting run as input-required without claiming completion", () => {
  expect(
    summarizeBotRun({ runs: [{ id: "run", status: "waiting", ordinal: 1 }], messages: [] }, "run")
      .status,
  ).toBe("waiting_input");
});
