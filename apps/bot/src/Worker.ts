import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BotError } from "./config.ts";
import * as Store from "./Store.ts";
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
  const step = Effect.gen(function* () {
    yield* store.tick();
    const job = yield* store.claim();
    if (!job) return false;
    yield* coordinator.run(job).pipe(
      Effect.flatMap((done) => (done ? store.finish(job) : Effect.void)),
      Effect.catch((cause) => store.finish(job, cause.category)),
    );
    return true;
  });
  const drain = Effect.gen(function* () {
    while (yield* step) {}
  });
  const run = Effect.gen(function* () {
    const worked = yield* step;
    yield* Effect.sleep(worked ? "20 millis" : "1 second");
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Bot worker waiting for recovery").pipe(
            Effect.andThen(Effect.sleep("2 seconds")),
          ),
    ),
    Effect.forever,
  );
  return Worker.of({ step, drain, run });
});

export const layer = Layer.effect(Worker, make);
