import type { BotCommand, BotGoal, BotTask } from "@t3tools/contracts/bot";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";

export function BotGoalRow({
  goal,
  tasks,
  run,
  openThread,
}: {
  goal: BotGoal;
  tasks: ReadonlyArray<BotTask>;
  run: (command: BotCommand) => Promise<unknown>;
  openThread: (threadId: string, environmentId: string) => void;
}) {
  const active = goal.state === "active" || goal.state === "verifying";
  const change = (state: "active" | "paused" | "cancelled") =>
    run({
      type: "goal.state",
      requestId: randomUUID(),
      id: goal.id,
      revision: goal.revision,
      state,
      reason:
        state === "active"
          ? "Owner resumed this goal"
          : state === "paused"
            ? "Owner paused this goal"
            : "Owner cancelled this goal",
    });
  return (
    <article className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">{goal.title}</h3>
        <span className="text-xs text-muted-foreground">{goal.state}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{goal.objective}</p>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {goal.criteria.map((criterion, index) => {
          const evidence = goal.evidence.find((e) => e.criterion === index);
          return (
            <li key={criterion}>
              {criterion}
              {evidence && (
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                  {evidence.quote}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {goal.reason && <p className="whitespace-pre-wrap text-sm">{goal.reason}</p>}
      <div className="flex flex-wrap gap-2">
        {tasks
          .filter((t) => t.goalId === goal.id && t.threadId)
          .map((task) => (
            <Button
              key={task.id}
              size="sm"
              variant="outline"
              onClick={() => openThread(task.threadId!, task.environmentId)}
            >
              {task.purpose === "verification" ? "Verification" : "Work"}: {task.title}
            </Button>
          ))}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void change(active ? "paused" : "active")}
        >
          {active
            ? "Pause"
            : goal.state === "completed" || goal.state === "cancelled"
              ? "Reopen"
              : "Resume"}
        </Button>
        {goal.state !== "completed" && goal.state !== "cancelled" && (
          <Button size="sm" variant="ghost" onClick={() => void change("cancelled")}>
            Cancel goal
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {goal.rounds}/{goal.roundLimit ?? 24} worker turns · Pausing or cancelling a goal stops new
        dispatch. Cancel running tasks separately.
      </p>
    </article>
  );
}
