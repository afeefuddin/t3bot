import { stableId } from "@t3tools/shared/stableId";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { BotConfig, BotError, isBotError } from "./config.ts";
import { equalSecret, verifySlackRequest } from "./connectorAuth.ts";
import * as Store from "./Store.ts";
import * as DeliveryStore from "./DeliveryStore.ts";

const SlackEvent = Schema.Struct({
  type: Schema.String,
  challenge: Schema.optionalKey(Schema.String),
  team_id: Schema.optionalKey(Schema.String),
  event_id: Schema.optionalKey(Schema.String),
  event: Schema.optionalKey(
    Schema.Struct({
      type: Schema.String,
      subtype: Schema.optionalKey(Schema.String),
      bot_id: Schema.optionalKey(Schema.String),
      user: Schema.optionalKey(Schema.String),
      channel: Schema.optionalKey(Schema.String),
      channel_type: Schema.optionalKey(Schema.String),
      text: Schema.optionalKey(Schema.String),
      ts: Schema.optionalKey(Schema.String),
      thread_ts: Schema.optionalKey(Schema.String),
    }),
  ),
});
const TelegramUpdate = Schema.Struct({
  update_id: Schema.Int,
  message: Schema.optionalKey(
    Schema.Struct({
      message_id: Schema.Int,
      text: Schema.optionalKey(Schema.String),
      from: Schema.optionalKey(Schema.Struct({ id: Schema.Int, is_bot: Schema.Boolean })),
      chat: Schema.Struct({ id: Schema.Int, type: Schema.String }),
    }),
  ),
});
const decodeSlack = Schema.decodeEffect(Schema.fromJsonString(SlackEvent));
const decodeTelegram = Schema.decodeEffect(Schema.fromJsonString(TelegramUpdate));
const ApiResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  error_code: Schema.optionalKey(Schema.Number),
  parameters: Schema.optionalKey(Schema.Struct({ retry_after: Schema.optionalKey(Schema.Number) })),
});
const decodeApi = Schema.decodeUnknownEffect(ApiResult);
class DeliveryError extends Schema.TaggedError<DeliveryError>()("ConnectorDeliveryError", {
  category: Schema.Literals(["unauthorized", "invalid", "unavailable", "rate_limited"]),
  retryAfterMs: Schema.optionalKey(Schema.Number),
}) {}
const isDeliveryError = Schema.is(DeliveryError);

export class Connectors extends Context.Service<
  Connectors,
  {
    readonly receive: (
      id: string,
      headers: Readonly<Record<string, string | undefined>>,
      raw: string,
    ) => Effect.Effect<{ ok: true } | { challenge: string }, BotError>;
    readonly step: Effect.Effect<boolean, BotError>;
    readonly run: Effect.Effect<never>;
  }
>()("@t3tools/bot/Connectors") {}

const make = Effect.gen(function* () {
  const config = yield* BotConfig;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.Store;
  const deliveries = yield* DeliveryStore.DeliveryStore;
  const http = yield* HttpClient.HttpClient;
  const receive = Effect.fn("BotConnectors.receive")(function* (
    id: string,
    headers: Readonly<Record<string, string | undefined>>,
    raw: string,
  ) {
    const connector = config.connectors?.find((c) => c.id === id);
    if (!connector || !(yield* deliveries.enabled(id)))
      return yield* new BotError({ category: "unauthorized" });
    const now = yield* Clock.currentTimeMillis;
    let eventId: string;
    let text: string;
    let destination: DeliveryStore.Destination;
    if (connector.type === "slack") {
      if (
        !verifySlackRequest(
          connector.verificationSecret,
          headers["x-slack-request-timestamp"] ?? "",
          headers["x-slack-signature"] ?? "",
          raw,
          now,
        )
      )
        return yield* new BotError({ category: "unauthorized" });
      const body = yield* decodeSlack(raw);
      if (body.type === "url_verification" && body.challenge) return { challenge: body.challenge };
      const event = body.event;
      if (body.type !== "event_callback" || !event || event.bot_id || event.subtype)
        return { ok: true } as const;
      if (
        body.team_id !== connector.teamId ||
        !event.user ||
        !connector.allowedUserIds.includes(event.user)
      )
        return yield* new BotError({ category: "unauthorized" });
      if (!event.channel || !event.ts || !body.event_id)
        return yield* new BotError({ category: "invalid" });
      const direct = event.type === "message" && event.channel_type === "im";
      const mention =
        event.type === "app_mention" && connector.allowedChannelIds.includes(event.channel);
      if (!direct && !mention) return { ok: true } as const;
      text = (event.text ?? "").replace(/^<@[A-Z0-9]+>\s*/, "").trim();
      eventId = body.event_id;
      destination = {
        type: "slack",
        channel: event.channel,
        threadTs: event.thread_ts ?? event.ts,
      };
    } else {
      if (
        !equalSecret(headers["x-telegram-bot-api-secret-token"] ?? "", connector.verificationSecret)
      )
        return yield* new BotError({ category: "unauthorized" });
      const update = yield* decodeTelegram(raw);
      const message = update.message;
      if (!message || message.from?.is_bot || message.chat.type !== "private" || !message.text)
        return { ok: true } as const;
      if (
        !message.from ||
        !connector.allowedUserIds.includes(String(message.from.id)) ||
        !connector.allowedChatIds.includes(String(message.chat.id))
      )
        return yield* new BotError({ category: "unauthorized" });
      text = message.text.trim();
      eventId = String(update.update_id);
      destination = {
        type: "telegram",
        chatId: String(message.chat.id),
        messageId: message.message_id,
      };
    }
    if (!text) return { ok: true } as const;
    if (text.length > 32000) return yield* new BotError({ category: "invalid" });
    const sourceId = stableId("incoming", id, eventId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* deliveries.enabled(id)))
          return yield* new BotError({ category: "unauthorized" });
        // Acknowledge only after both the route and coordinator work have committed.
        yield* deliveries.bind(sourceId, id, destination);
        yield* store.command({ type: "message", requestId: sourceId, text });
      }),
    );
    return { ok: true } as const;
  });
  const send = Effect.fn("BotConnectors.send")(function* (delivery: DeliveryStore.Delivery) {
    const connector = config.connectors?.find((c) => c.id === delivery.connector_id);
    if (!connector || connector.type !== delivery.destination.type)
      return yield* new DeliveryError({ category: "invalid" });
    let request: HttpClientRequest.HttpClientRequest;
    if (delivery.destination.type === "slack") {
      request = HttpClientRequest.post("https://slack.com/api/chat.postMessage").pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${connector.botToken}`),
        HttpClientRequest.bodyJsonUnsafe({
          channel: delivery.destination.channel,
          thread_ts: delivery.destination.threadTs,
          text: delivery.text
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;"),
          mrkdwn: false,
          parse: "none",
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
    } else {
      request = HttpClientRequest.post(
        `https://api.telegram.org/bot${connector.botToken}/sendMessage`,
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          chat_id: delivery.destination.chatId,
          text: delivery.text,
          reply_parameters: {
            message_id: delivery.destination.messageId,
            allow_sending_without_reply: true,
          },
          link_preview_options: { is_disabled: true },
        }),
      );
    }
    const response = yield* http.execute(request);
    if (response.status === 401 || response.status === 403)
      return yield* new DeliveryError({ category: "unauthorized" });
    if (response.status === 429) {
      const fallback: typeof ApiResult.Type = { ok: false };
      const details = yield* response.json.pipe(
        Effect.flatMap(decodeApi),
        Effect.orElseSucceed(() => fallback),
      );
      const seconds =
        details.parameters?.retry_after ?? Number(response.headers["retry-after"] ?? 5);
      return yield* new DeliveryError({
        category: "rate_limited",
        retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : 5000,
      });
    }
    if (response.status >= 500) return yield* new DeliveryError({ category: "unavailable" });
    if (response.status < 200 || response.status >= 300)
      return yield* new DeliveryError({ category: "invalid" });
    const result = yield* response.json.pipe(Effect.flatMap(decodeApi));
    if (result.ok) return;
    if (result.error_code === 429 || result.error === "ratelimited")
      return yield* new DeliveryError({
        category: "rate_limited",
        retryAfterMs: (result.parameters?.retry_after ?? 5) * 1000,
      });
    if (
      result.error_code === 401 ||
      result.error_code === 403 ||
      ["invalid_auth", "token_revoked", "not_authed", "account_inactive"].includes(
        result.error ?? "",
      )
    )
      return yield* new DeliveryError({ category: "unauthorized" });
    if (
      result.error_code === 400 ||
      ["channel_not_found", "not_in_channel", "is_archived"].includes(result.error ?? "")
    )
      return yield* new DeliveryError({ category: "invalid" });
    return yield* new DeliveryError({ category: "unavailable" });
  });
  const step = Effect.gen(function* () {
    const delivery = yield* deliveries.claim;
    if (!delivery) return false;
    yield* send(delivery).pipe(
      Effect.timeout("20 seconds"),
      // Telegram includes its credential in the API path; never persist or log transport causes.
      Effect.mapError((cause) =>
        isDeliveryError(cause) ? cause : new DeliveryError({ category: "unavailable" }),
      ),
      Effect.flatMap(() => deliveries.finish(delivery)),
      Effect.catch((cause) =>
        deliveries.finish(delivery, isDeliveryError(cause) ? cause : { category: "unavailable" }),
      ),
    );
    return true;
  });
  const run = step.pipe(
    Effect.andThen(Effect.sleep("1 second")),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Connector delivery waiting for recovery").pipe(
            Effect.andThen(Effect.sleep("3 seconds")),
          ),
    ),
    Effect.forever,
  );
  return Connectors.of({
    receive: (...args) =>
      receive(...args).pipe(
        Effect.mapError((cause) =>
          isBotError(cause) ? cause : new BotError({ category: "invalid" }),
        ),
      ),
    step,
    run,
  });
});
export const layer = Layer.effect(Connectors, make);
