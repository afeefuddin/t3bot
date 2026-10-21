import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize")
    send({
      id,
      result: {
        userAgent: "bot-test",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
  if (method === "thread/start") {
    if (
      !params.ephemeral ||
      params.sandbox !== "read-only" ||
      params.approvalPolicy !== "never" ||
      params.config["features.shell_tool"] !== false
    )
      process.exit(5);
    send({
      id,
      result: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: process.cwd(),
        model: "test",
        modelProvider: "test",
        sandbox: { type: "readOnly" },
        thread: {
          id: "test-thread",
          sessionId: "test-session",
          cliVersion: "test",
          createdAt: 0,
          updatedAt: 0,
          cwd: process.cwd(),
          ephemeral: true,
          modelProvider: "test",
          preview: "",
          projectId: null,
          source: "appServer",
          status: { type: "idle" },
          turns: [],
        },
      },
    });
  }
  if (method === "turn/start") {
    const { messages, tools } = JSON.parse(params.input[0].text);
    const mode = messages.at(-1).content;
    if (mode === "exit") process.exit(7);
    const turn = { id: "turn", items: [], status: "completed", error: null };
    send({ id, result: { turn } });
    let invalidOnce = false;
    if (mode.startsWith("flaky:")) {
      try {
        NodeFS.writeFileSync(mode.slice(6), "attempted", { flag: "wx" });
        invalidOnce = true;
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
      }
    }
    const text =
      mode === "invalid" || invalidOnce
        ? "invalid json"
        : JSON.stringify(
            mode === "remember"
              ? {
                  content: null,
                  calls: [{ name: tools[0].function.name, arguments: '{"text":"tea"}' }],
                }
              : mode === "unknown"
                ? { content: null, calls: [{ name: "run_shell", arguments: "{}" }] }
                : { content: "A real-shaped response.", calls: [] },
          );
    send({
      method: "item/completed",
      params: {
        completedAtMs: 0,
        threadId: "test-thread",
        turnId: "turn",
        item: { id: "answer", type: "agentMessage", text },
      },
    });
    if (mode === "failed") turn.status = "failed";
    send({ method: "turn/completed", params: { threadId: "test-thread", turn } });
  }
}
