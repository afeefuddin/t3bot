import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BotError } from "./config.ts";
import * as Store from "./Store.ts";
import type { JobLane } from "./Jobs.ts";
import * as Processes from "./Processes.ts";
import * as Option from "effect/Option";
import * as Coordinator from "./Coordinator.ts";

export class Worker extends Context.Service<
  Worker,
  {
    readonly step: Effect.Effect<boolean, BotError>;
    readonly drain: Effect.Effect<void, BotError>;
    readonly run: Effect.Effect<never>;
  }
>()("@t3tools/bot/Worker") {}

const make = Effect.gen(function* () {
  const store = yield* Store.Store;
  const coordinator = yield* Coordinator.Coordinator;
  const processes = yield* Effect.serviceOption(Processes.Processes);
  const stepFor = Effect.fn("BotWorker.step")(function* (lane: JobLane) {
    if (lane === "coordinator") {
      if (Option.isSome(processes)) yield* processes.value.flush;
      yield* store.tick();
    }
    const job = yield* store.claim(lane);
    if (!job) return false;
    const state = yield* coordinator.run(job).pipe(
      Effect.flatMap((done) => (done ? store.finish(job) : Effect.succeed(null))),
      Effect.catch((cause) => store.finish(job, cause.category)),
    );
    if (job.kind === "agent" && state === "failed" && Option.isSome(processes))
      yield* processes.value.cancelOwner(job.id);
    return true;
  });
  const step = stepFor("coordinator");
  const drain = Effect.gen(function* () {
    while ((yield* step) || (yield* stepFor("background"))) {}
  });
  const loop = Effect.fn("BotWorker.loop")(
    function* (lane: JobLane) {
      const worked = yield* stepFor(lane);
      yield* Effect.sleep(worked ? "20 millis" : "1 second");
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Bot worker waiting for recovery").pipe(
            Effect.andThen(Effect.sleep("2 seconds")),
          ),
    ),
    (effect) => Effect.forever(effect),
  );
  const run = Effect.all([loop("coordinator"), loop("background"), loop("background")], {
    concurrency: "unbounded",
  }).pipe(Effect.andThen(Effect.never));
  return Worker.of({ step, drain, run });
});

export const layer = Layer.effect(Worker, make);
