import { assert, it } from "@effect/vitest";
import type { BotSnapshot } from "@t3tools/contracts/bot";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { BotConfig, type BotError } from "./config.ts";
import * as Coordinator from "./Coordinator.ts";
import * as Database from "./database.ts";
import * as Model from "./Model.ts";
import * as Store from "./Store.ts";
import * as Worker from "./Worker.ts";

it.effect(
  "owns a goal through work, failed verification, repair, and passing verification without more user messages",
  () => {
    let snapshot: (() => Effect.Effect<BotSnapshot, BotError>) | undefined;
    let context: Store.Store["Service"]["goalContext"] | undefined;
    const calls: string[] = [];
    const model = Layer.succeed(
      Model.Model,
      Model.Model.of({
        complete: (_provider, _messages, tools) =>
          Effect.gen(function* () {
            assert.ok(snapshot);
            const state = yield* snapshot();
            const goal = state.goals?.[0];
            const task = state.tasks[0];
            const receipts =
              goal && context
                ? ((yield* context(goal.id)).tasks.find((t) => t.id === task?.id)?.checks ?? [])
                : [];
            const selected = !goal
              ? {
                  name: "create_goal",
                  args: {
                    id: "fix",
                    title: "Fix regression",
                    objective: "Fix the failing calculation",
                    criteria: ["Regression test passes"],
                    environmentId: "env",
                    projectId: "project",
                  },
                }
              : !task
                ? {
                    name: "start_task",
                    args: {
                      goalId: goal.id,
                      threadId: null,
                      title: "Fix",
                      instructions: "Fix and test the bug",
                      environmentId: "env",
                      projectId: "project",
                      isolated: true,
                    },
                  }
                : task.status === "completed" && task.purpose === "work"
                  ? {
                      name: "verify_goal",
                      args: { id: goal.id, revision: goal.revision, taskId: task.id },
                    }
                  : task.status === "completed" &&
                      task.purpose === "verification" &&
                      task.result.startsWith("FAIL")
                    ? {
                        name: "followup_task",
                        args: {
                          id: task.id,
                          text: "The regression still fails. Repair it, then report the checks.",
                        },
                      }
                    : task.status === "completed" &&
                        task.purpose === "verification" &&
                        goal.state !== "completed"
                      ? {
                          name: "complete_goal",
                          args: {
                            id: goal.id,
                            revision: goal.revision,
                            summary: "The regression is fixed and verified.",
                            evidence: [
                              {
                                criterion: 0,
                                taskId: task.id,
                                generation: task.generation,
                                runId: task.runId,
                                quote: task.result,
                                checkIds: receipts.map((check) => check.id),
                              },
                            ],
                          },
                        }
                      : tools.some((t) => t.function.name === "complete_silently")
                        ? { name: "complete_silently", args: {} }
                        : null;
            if (!selected)
              return {
                tokens: 100,
                message: {
                  role: "assistant" as const,
                  content: "Work is running; I will check its result.",
                },
              };
            calls.push(selected.name);
            return {
              tokens: 100,
              message: {
                role: "assistant" as const,
                content: null,
                tool_calls: [
                  {
                    id: `call-${calls.length}`,
                    type: "function" as const,
                    function: { name: selected.name, arguments: JSON.stringify(selected.args) },
                  },
                ],
              },
            };
          }),
      }),
    );
    const config = Layer.succeed(BotConfig, {
      provider: "test",
      providers: [{ id: "test", endpoint: "http://localhost", model: "test", apiKey: "" }],
    });
    const layer = Worker.layer.pipe(
      Layer.provideMerge(Coordinator.layer),
      Layer.provideMerge(Store.layer),
      Layer.provide(model),
      Layer.provideMerge(Database.layer(":memory:")),
      Layer.provide(config),
    );
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const worker = yield* Worker.Worker;
      snapshot = () => store.snapshot();
      context = store.goalContext;
      const poll = {
        protocol: 1,
        identity: "machine",
        projects: [{ id: "project", title: "Workspace", instanceId: "worker", model: "test" }],
      } as const;
      yield* store.command({
        type: "settings",
        requestId: "settings",
        provider: "test",
        autoMemory: false,
      });
      yield* store.command(
        { type: "environment.create", requestId: "env", name: "Machine" },
        "hash",
      );
      yield* store.poll("env", "hash", poll);
      yield* store.command({
        type: "message",
        requestId: "request",
        text: "Investigate and fix the calculation bug",
      });
      yield* worker.drain;
      yield* TestClock.adjust("11 seconds");
      for (const [index, result] of [
        "Implemented the fix",
        "FAIL 1: node --test: 1 failing test",
        "Corrected the fix",
        "PASS 1: node --test: 1 passed, 0 failed",
      ].entries()) {
        const commands = (yield* store.poll("env", "hash", poll)).commands;
        const command = commands.find((c) => c.kind !== "inspect");
        assert.ok(command);
        assert.equal(command.kind, index === 0 ? "start" : "followup");
        yield* store.report("env", "hash", {
          commandId: command.id,
          taskId: command.taskId,
          threadId: command.threadId,
          runId: `run-${index}`,
          status: "completed",
          result,
          checks: [
            {
              id: `check-${index}`,
              runId: `run-${index}`,
              command: "node --test",
              output: result,
              outcome: index === 1 ? "failed" : "passed",
              exitCode: index === 1 ? 1 : 0,
            },
          ],
        });
        yield* worker.drain;
        if (index < 3) assert.notEqual((yield* store.snapshot()).goals?.[0]?.state, "completed");
      }
      const final = yield* store.snapshot();
      assert.equal(final.goals?.[0]?.state, "completed");
      assert.equal(final.tasks.length, 1);
      assert.equal(final.messages.filter((m) => m.role === "user").length, 1);
      assert.equal(calls.filter((name) => name === "start_task").length, 1);
      assert.equal(calls.filter((name) => name === "verify_goal").length, 2);
      assert.include(
        final.messages.find((m) => m.text.startsWith("Goal completed:"))?.text ?? "",
        "t3-thread://v1/",
      );
    }).pipe(Effect.provide(layer));
  },
);
