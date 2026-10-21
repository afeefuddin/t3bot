import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BotConnection from "./BotConnection.ts";

const config = {
  url: "http://127.0.0.1:3780",
  grantId: "machine",
  token: "private-fixture-token-long-enough",
  projectIds: ["project"],
  runtimeMode: "approval-required",
} as const;

it.effect(
  "stores a private grant, updates project access without exposing the token, and keeps disconnect across restarts",
  () => {
    let stored: Uint8Array | undefined;
    const dependencies = Layer.merge(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () => Effect.sync(() => Option.fromUndefinedOr(stored)),
        set: (_name, value) =>
          Effect.sync(() => {
            stored = value;
          }),
      }),
      Layer.succeed(HostProcess.Environment, {
        T3BOT_URL: config.url,
        T3BOT_BRIDGE_ID: config.grantId,
        T3BOT_BRIDGE_TOKEN: config.token,
        T3BOT_BRIDGE_PROJECT_IDS: "project",
      }),
    );
    const layer = BotConnection.layer.pipe(Layer.provide(dependencies));
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* BotConnection.BotConnection;
          assert.equal((yield* service.current)?.token, config.token);
          const status = yield* service.configure(config);
          assert.ok(status);
          assert.notProperty(status, "token");
          const { token: _token, ...publicConfig } = config;
          yield* service.configure({ ...publicConfig, projectIds: ["second"] });
          assert.equal((yield* service.current)?.token, config.token);
        }).pipe(Effect.provide(layer)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* BotConnection.BotConnection;
          assert.deepEqual((yield* service.current)?.projectIds, ["second"]);
          yield* service.configure(null);
        }).pipe(Effect.provide(layer)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* BotConnection.BotConnection;
          assert.equal(yield* service.current, null);
        }).pipe(Effect.provide(layer)),
      );
    });
  },
);

it.effect.each([
  "https://owner:secret@bot.example",
  "file:///tmp/bot",
  "https://bot.example?token=secret",
])("rejects an invalid bot URL %s without saving a grant", (url) => {
  let writes = 0;
  const layer = BotConnection.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeed(Option.none()),
          set: () =>
            Effect.sync(() => {
              writes++;
            }),
        }),
        Layer.succeed(HostProcess.Environment, {}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* BotConnection.BotConnection;
    assert.equal(
      (yield* service.configure({ ...config, url }).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(writes, 0);
    assert.equal(yield* service.current, null);
  }).pipe(Effect.provide(layer));
});
