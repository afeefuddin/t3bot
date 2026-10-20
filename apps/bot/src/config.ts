import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

const HttpProviderConfig = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  endpoint: Schema.String.check(Schema.isMinLength(1)),
  model: Schema.String.check(Schema.isMinLength(1)),
  apiKeyEnv: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  api: Schema.optionalKey(Schema.Literals(["chat_completions", "responses"])),
  reasoningEffort: Schema.optionalKey(Schema.Literals(["low", "medium", "high"])),
  maxTokensField: Schema.optionalKey(Schema.Literals(["max_tokens", "max_completion_tokens"])),
});
export const ProviderConfig = Schema.Union([
  HttpProviderConfig,
  Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    type: Schema.Literal("codex"),
    model: Schema.String.check(Schema.isMinLength(1)),
    binary: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  }),
]);
export type ProviderConfig = typeof ProviderConfig.Type;
const ConnectorId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const OwnerIds = Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
  Schema.isMinLength(1),
);
const ConnectorFields = {
  id: ConnectorId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  botTokenEnv: Schema.String.check(Schema.isMinLength(1)),
  allowedUserIds: OwnerIds,
};
export const ConnectorConfig = Schema.Union([
  Schema.Struct({
    ...ConnectorFields,
    type: Schema.Literal("slack"),
    signingSecretEnv: Schema.String.check(Schema.isMinLength(1)),
    teamId: Schema.String.check(Schema.isMinLength(1)),
    allowedChannelIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...ConnectorFields,
    type: Schema.Literal("telegram"),
    webhookSecretEnv: Schema.String.check(Schema.isMinLength(1)),
    allowedChatIds: OwnerIds,
  }),
]);
export type ConnectorConfig = typeof ConnectorConfig.Type & {
  readonly botToken: string;
  readonly verificationSecret: string;
};
export const BotFileConfig = Schema.Struct({
  providers: Schema.Array(ProviderConfig),
  provider: Schema.String,
  allowedOrigins: Schema.Array(Schema.String),
  connectors: Schema.optionalKey(Schema.Array(ConnectorConfig)),
});
export type BotFileConfig = typeof BotFileConfig.Type;

export class BotConfig extends Context.Service<
  BotConfig,
  {
    readonly providers: ReadonlyArray<typeof ProviderConfig.Type & { readonly apiKey: string }>;
    readonly provider: string;
    readonly connectors?: ReadonlyArray<ConnectorConfig>;
  }
>()("@t3tools/bot/config/BotConfig") {}

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  category: Schema.Literals([
    "conflict",
    "not_found",
    "invalid",
    "unauthorized",
    "unavailable",
    "budget",
    "storage",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Bot operation failed (${this.category}).`;
  }
}

export const isBotError = Schema.is(BotError);
