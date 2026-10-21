import {
  BotBridgeConnectionConfig,
  BotConnectionError,
  type BotBridgeConnectionInput,
} from "@t3tools/contracts/bot";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const isConnectionError = Schema.is(BotConnectionError);
const Stored = Schema.NullOr(BotBridgeConnectionConfig);
const decode = Schema.decodeUnknownEffect(Stored);
const encode = Schema.encodeEffect(Schema.fromJsonString(Stored));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Stored));
const publicStatus = (config: BotBridgeConnectionConfig | null) =>
  config && {
    url: config.url,
    grantId: config.grantId,
    projectIds: config.projectIds,
    runtimeMode: config.runtimeMode,
  };

export class BotConnection extends Context.Service<
  BotConnection,
  {
    readonly current: Effect.Effect<BotBridgeConnectionConfig | null>;
    readonly configure: (
      connection: BotBridgeConnectionInput | null,
    ) => Effect.Effect<ReturnType<typeof publicStatus>, BotConnectionError>;
  }
>()("t3/bot/BotConnection") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const env = yield* HostProcess.Environment;
  const saved = yield* secrets.get("bot-bridge");
  const initial = Option.isSome(saved)
    ? yield* decodeJson(new TextDecoder().decode(saved.value))
    : env.T3BOT_URL && env.T3BOT_BRIDGE_ID && env.T3BOT_BRIDGE_TOKEN && env.T3BOT_BRIDGE_PROJECT_IDS
      ? yield* decode({
          url: env.T3BOT_URL.replace(/\/$/, ""),
          grantId: env.T3BOT_BRIDGE_ID,
          token: env.T3BOT_BRIDGE_TOKEN,
          projectIds: env.T3BOT_BRIDGE_PROJECT_IDS.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          runtimeMode: env.T3BOT_BRIDGE_MODE ?? "approval-required",
        })
      : null;
  const state = yield* Ref.make(initial);
  const configure = Effect.fn("BotConnection.configure")(
    function* (connection: BotBridgeConnectionInput | null) {
      const previous = yield* Ref.get(state);
      const token =
        connection?.token ??
        (previous?.url === connection?.url && previous?.grantId === connection?.grantId
          ? previous?.token
          : undefined);
      const valid = yield* decode(connection ? { ...connection, token } : null);
      if (valid) {
        const parsed = yield* Effect.try({
          try: () => new URL(valid.url),
          catch: (cause) => new BotConnectionError({ category: "configuration", cause }),
        });
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          valid.projectIds.includes("*")
        )
          return yield* new BotConnectionError({ category: "configuration" });
      }
      const normalized = valid
        ? {
            ...valid,
            url: valid.url.replace(/\/$/, ""),
            projectIds: [...new Set(valid.projectIds)],
          }
        : null;
      // Persist null on disconnect so a restart cannot reactivate an ambient environment grant.
      yield* secrets.set("bot-bridge", new TextEncoder().encode(yield* encode(normalized)));
      yield* Ref.set(state, normalized);
      return publicStatus(normalized);
    },
    Effect.mapError((cause) =>
      isConnectionError(cause) ? cause : new BotConnectionError({ category: "storage", cause }),
    ),
  );
  return BotConnection.of({ current: Ref.get(state), configure });
});

export const layer = Layer.effect(BotConnection, make);
