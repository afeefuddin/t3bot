import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isBotError } from "./config.ts";
import { completeCodex } from "./codex.ts";

it.layer(NodeServices.layer)("Codex coordinator", (it) => {
  const run = Effect.fn(function* (mode: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3bot-codex-test-" });
    const binary = path.join(directory, "codex");
    yield* fs.writeFileString(
      binary,
      `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dirname, "../test/codex-peer.mjs")}'\n`,
    );
    yield* fs.chmod(binary, 0o700);
    return yield* completeCodex(
      { id: "test", type: "codex", model: "test", binary },
      [{ role: "user", content: mode }],
      [
        {
          type: "function",
          function: { name: "remember", description: "Save memory", parameters: {} },
        },
      ],
    );
  });
  it.effect("returns replies and tool intentions without executing them", () =>
    Effect.gen(function* () {
      const reply = yield* run("reply");
      assert.equal(reply.message.content, "A real-shaped response.");
      assert.isAbove(reply.tokens, 0);
      const tool = yield* run("remember");
      assert.equal(tool.message.content, null);
      assert.deepEqual(tool.message.tool_calls?.[0]?.function, {
        name: "remember",
        arguments: '{"text":"tea"}',
      });
    }),
  );
  it.effect.each(["invalid", "unknown", "failed", "exit"])("fails when Codex returns %s", (mode) =>
    Effect.gen(function* () {
      const result = yield* run(mode).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure" && isBotError(result.failure))
        assert.equal(
          result.failure.category,
          mode === "invalid" || mode === "unknown" ? "invalid" : "unavailable",
        );
    }),
  );
});
