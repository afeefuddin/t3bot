// @effect-diagnostics nodeBuiltinImport:off -- Sign fixture requests using the platform's HMAC implementation.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { BotConfig } from "./config.ts";
import * as Database from "./database.ts";
import * as Store from "./Store.ts";
import * as DeliveryStore from "./DeliveryStore.ts";
import * as Connectors from "./Connectors.ts";
import * as Coordinator from "./Coordinator.ts";
import * as Model from "./Model.ts";

const slackSecret = "fixture-slack-signing-secret";
const telegramSecret = "fixture-telegram-webhook-secret-1234";
const slack = (id = "event-1", extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "event_callback",
    team_id: "TWORK",
    event_id: id,
    event: {
      type: "message",
      channel_type: "im",
      channel: "DCHAT",
      ts: "100.001",
      user: "UOWNER",
      text: "Research this",
      ...extra,
    },
  });
const signed = (raw: string, timestamp = "0") => ({
  "x-slack-request-timestamp": timestamp,
  "x-slack-signature": `v0=${NodeCrypto.createHmac("sha256", slackSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`,
});
const telegram = (id = 1, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    update_id: id,
    message: {
      message_id: 5,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      text: "Research this",
      ...extra,
    },
  });
const telegramHeaders = { "x-telegram-bot-api-secret-token": telegramSecret };
interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}
function harness(responses: Reply[] = [], realModel = false) {
  const modelRequests: Array<{ model: unknown; authorization: string | undefined }> = [];
  const sent: Array<{
    url: string;
    body: Record<string, unknown>;
    authorization: string | undefined;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
            : {};
        if (request.url === "http://fixture" || request.url === "http://alternative-fixture") {
          modelRequests.push({ model: body.model, authorization: request.headers.authorization });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              choices: [
                { message: { role: "assistant", content: "Reply from selected provider." } },
              ],
              usage: { total_tokens: 50 },
            }),
          );
        }
        sent.push({ url: request.url, body, authorization: request.headers.authorization });
        const reply = responses.shift() ?? { body: { ok: true } };
        return HttpClientResponse.fromWeb(
          request,
          Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers ?? {} }),
        );
      }),
    ),
  );
  const config = Layer.succeed(
    BotConfig,
    BotConfig.of({
      provider: "primary",
      providers: [
        {
          id: "primary",
          endpoint: "http://fixture",
          model: "fixture",
          apiKey: "primary-fixture-key",
        },
        {
          id: "alternative",
          endpoint: "http://alternative-fixture",
          model: "alternative-model",
          apiKey: "alternative-fixture-key",
        },
      ],
      connectors: [
        {
          type: "slack",
          id: "work-slack",
          name: "Work Slack",
          teamId: "TWORK",
          allowedUserIds: ["UOWNER"],
          allowedChannelIds: ["CAPP"],
          botTokenEnv: "SLACK_TOKEN",
          signingSecretEnv: "SLACK_SECRET",
          botToken: "slack-fixture-token",
          verificationSecret: slackSecret,
        },
        {
          type: "telegram",
          id: "personal-telegram",
          name: "Personal Telegram",
          allowedUserIds: ["42"],
          allowedChatIds: ["42"],
          botTokenEnv: "TELEGRAM_TOKEN",
          webhookSecretEnv: "TELEGRAM_SECRET",
          botToken: "telegram-fixture-token",
          verificationSecret: telegramSecret,
        },
      ],
    }),
  );
  const model = realModel
    ? Model.layer
    : Layer.succeed(
        Model.Model,
        Model.Model.of({
          complete: () =>
            Effect.succeed({
              message: { role: "assistant", content: "Here is the evidence." },
              tokens: 50,
            }),
        }),
      );
  const layer = Layer.merge(Connectors.layer, Coordinator.layer).pipe(
    Layer.provideMerge(Store.layer),
    Layer.provide(model.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(http),
    Layer.provideMerge(Database.layer(":memory:")),
    Layer.provide(config),
  );
  return { layer, sent, modelRequests };
}
const answer = Effect.gen(function* () {
  const store = yield* Store.Store;
  const coordinator = yield* Coordinator.Coordinator;
  const job = yield* store.claim();
  assert.ok(job);
  assert.equal(yield* coordinator.run(job), true);
  yield* store.finish(job);
});

it.effect(
  "acknowledges signed Slack events durably, deduplicates retries, and replies to the originating thread",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const connectors = yield* Connectors.Connectors;
      const store = yield* Store.Store;
      const challenge = JSON.stringify({ type: "url_verification", challenge: "challenge" });
      assert.deepEqual(yield* connectors.receive("work-slack", signed(challenge), challenge), {
        challenge: "challenge",
      });
      const body = slack();
      yield* connectors.receive("work-slack", signed(body), body);
      yield* connectors.receive("work-slack", signed(body), body);
      assert.equal((yield* store.snapshot()).messages.length, 1);
      assert.equal(h.sent.length, 0);
      yield* answer;
      assert.equal(yield* connectors.step, true);
      assert.equal(yield* connectors.step, false);
      assert.equal(h.sent.length, 1);
      assert.equal(h.sent[0]?.url, "https://slack.com/api/chat.postMessage");
      assert.equal(h.sent[0]?.body.channel, "DCHAT");
      assert.equal(h.sent[0]?.body.thread_ts, "100.001");
      assert.equal(h.sent[0]?.body.text, "Here is the evidence.");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "rejects forged/stale Slack requests and unauthorized senders; ignores bot loops and unrelated channels",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const connectors = yield* Connectors.Connectors;
      const store = yield* Store.Store;
      const raw = slack();
      assert.equal(
        (yield* connectors.receive("work-slack", signed(raw), raw + " ").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* connectors.receive("work-slack", signed(raw, "600"), raw).pipe(Effect.result))._tag,
        "Failure",
      );
      for (const event of [
        slack("team", { user: "OTHER" }),
        JSON.stringify({
          type: "event_callback",
          team_id: "WRONG",
          event_id: "wrong-team",
          event: {
            type: "message",
            channel_type: "im",
            channel: "DCHAT",
            ts: "1",
            user: "UOWNER",
            text: "No",
          },
        }),
      ])
        assert.equal(
          (yield* connectors.receive("work-slack", signed(event), event).pipe(Effect.result))._tag,
          "Failure",
        );
      for (const event of [
        slack("bot", { bot_id: "BAPP" }),
        slack("edit", { subtype: "message_changed" }),
        slack("channel", { channel_type: "channel", channel: "CAPP" }),
      ])
        yield* connectors.receive("work-slack", signed(event), event);
      assert.equal((yield* store.snapshot()).messages.length, 0);
      const mention = slack("mention", {
        type: "app_mention",
        channel: "CAPP",
        thread_ts: "99.1",
        text: "<@BAPP> Research this",
      });
      yield* connectors.receive("work-slack", signed(mention), mention);
      yield* answer;
      yield* connectors.step;
      assert.equal(h.sent[0]?.body.thread_ts, "99.1");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "accepts allowlisted Telegram private messages once and replies without parsing untrusted Markdown",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const connectors = yield* Connectors.Connectors;
      const store = yield* Store.Store;
      assert.equal(
        (yield* connectors.receive("personal-telegram", {}, telegram()).pipe(Effect.result))._tag,
        "Failure",
      );
      const outsider = telegram(2, { from: { id: 99, is_bot: false } });
      assert.equal(
        (yield* connectors
          .receive("personal-telegram", telegramHeaders, outsider)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* connectors.receive(
        "personal-telegram",
        telegramHeaders,
        telegram(3, { chat: { id: 42, type: "group" } }),
      );
      yield* connectors.receive("personal-telegram", telegramHeaders, telegram());
      yield* connectors.receive("personal-telegram", telegramHeaders, telegram());
      assert.equal((yield* store.snapshot()).messages.length, 1);
      yield* answer;
      yield* connectors.step;
      assert.equal(h.sent[0]?.body.chat_id, "42");
      assert.deepEqual(h.sent[0]?.body.reply_parameters, {
        message_id: 5,
        allow_sending_without_reply: true,
      });
      assert.equal(h.sent[0]?.body.parse_mode, undefined);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "rolls back the inbound route and message when durable coordinator work cannot be recorded",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const connectors = yield* Connectors.Connectors;
      const store = yield* Store.Store;
      yield* sql`CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END`;
      assert.equal(
        (yield* connectors
          .receive("personal-telegram", telegramHeaders, telegram())
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* sql`SELECT * FROM connector_routes`).length, 0);
      assert.equal((yield* store.snapshot()).messages.length, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "pauses ingress and queued replies, surfaces failed delivery, and retries it through the existing job command",
  () => {
    const h = harness([{ status: 401, body: { ok: false } }]);
    return Effect.gen(function* () {
      const connectors = yield* Connectors.Connectors;
      const store = yield* Store.Store;
      yield* connectors.receive("personal-telegram", telegramHeaders, telegram());
      yield* answer;
      yield* store.command({
        type: "connector.state",
        requestId: "pause",
        id: "personal-telegram",
        enabled: false,
      });
      assert.equal(yield* connectors.step, false);
      assert.equal(
        (yield* connectors
          .receive("personal-telegram", telegramHeaders, telegram(2))
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* store.command({
        type: "connector.state",
        requestId: "resume",
        id: "personal-telegram",
        enabled: true,
      });
      yield* connectors.step;
      const snapshot = yield* store.snapshot();
      const failed = snapshot.jobs.find((j) => j.kind === "delivery:personal-telegram");
      assert.ok(failed);
      assert.equal(failed.state, "failed");
      assert.equal(failed.error, "unauthorized");
      yield* store.command({ type: "job.retry", requestId: "retry", id: failed.id });
      yield* connectors.step;
      assert.equal(
        (yield* store.snapshot()).connectors?.find((c) => c.id === "personal-telegram")?.failed,
        0,
      );
      assert.equal(h.sent.length, 2);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("honors Telegram retry_after and preserves Unicode chunk order through a restart", () => {
  const h = harness([
    { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 120 } } },
  ]);
  return Effect.gen(function* () {
    const connectors = yield* Connectors.Connectors;
    const store = yield* Store.Store;
    const deliveries = yield* DeliveryStore.DeliveryStore;
    yield* deliveries.bind("origin", "personal-telegram", {
      type: "telegram",
      chatId: "42",
      messageId: 5,
    });
    const text = "a".repeat(2999) + "😀" + "b".repeat(50);
    yield* store.append("long", "assistant", text, "origin");
    yield* connectors.step;
    assert.equal(yield* connectors.step, false);
    yield* TestClock.adjust("119 seconds");
    assert.equal(yield* connectors.step, false);
    yield* TestClock.adjust("1 second");
    const claimed = yield* deliveries.claim;
    assert.ok(claimed);
    yield* store.recover;
    yield* deliveries.finish(claimed);
    yield* connectors.step;
    yield* connectors.step;
    assert.equal(h.sent.length, 3);
    assert.equal(String(h.sent[1]?.body.text) + String(h.sent[2]?.body.text), text);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "keeps asynchronous task results attached to the originating connector after recovery",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const connectors = yield* Connectors.Connectors;
      const deliveries = yield* DeliveryStore.DeliveryStore;
      yield* deliveries.bind("source-job", "personal-telegram", {
        type: "telegram",
        chatId: "42",
        messageId: 5,
      });
      yield* store.command(
        { type: "environment.create", requestId: "cloud", name: "Cloud" },
        "hash",
      );
      const poll = {
        protocol: 1 as const,
        identity: "actual-cloud",
        projects: [{ id: "workspace", title: "Workspace", instanceId: "codex", model: "fixture" }],
      };
      yield* store.poll("cloud", "hash", poll);
      yield* store.command(
        {
          type: "task.start",
          requestId: "cloud-task",
          title: "Research",
          instructions: "Research this",
          environmentId: "cloud",
          projectId: "workspace",
          isolated: false,
        },
        undefined,
        undefined,
        "source-job",
      );
      yield* TestClock.adjust("11 seconds");
      const bridge = yield* store.poll("cloud", "hash", poll);
      const command = bridge.commands[0];
      assert.ok(command);
      yield* store.recover;
      yield* store.report("cloud", "hash", {
        commandId: command.id,
        taskId: command.taskId,
        threadId: command.threadId,
        runId: "run",
        status: "completed",
        result: "Evidence found",
      });
      yield* answer;
      while (yield* connectors.step) {}
      assert.equal(h.sent.length, 2);
      assert.ok(String(h.sent[0]?.body.text).includes("Evidence found"));
      assert.equal(h.sent[1]?.body.text, "Here is the evidence.");
      assert.ok(h.sent.every((s) => s.body.chat_id === "42"));
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("uses the selected OpenAI-compatible provider for both messaging connectors", () => {
  const h = harness([], true);
  return Effect.gen(function* () {
    const store = yield* Store.Store;
    const connectors = yield* Connectors.Connectors;
    yield* store.command({
      type: "settings",
      requestId: "provider",
      provider: "alternative",
      autoMemory: false,
    });
    const raw = slack();
    yield* connectors.receive("work-slack", signed(raw), raw);
    yield* answer;
    yield* connectors.step;
    yield* connectors.receive("personal-telegram", telegramHeaders, telegram());
    yield* answer;
    yield* connectors.step;
    assert.equal(h.modelRequests.length, 2);
    assert.ok(
      h.modelRequests.every(
        (r) =>
          r.model === "alternative-model" && r.authorization === "Bearer alternative-fixture-key",
      ),
    );
    assert.equal(h.sent[0]?.body.channel, "DCHAT");
    assert.equal(h.sent[1]?.body.chat_id, "42");
    assert.ok(h.sent.every((r) => r.body.text === "Reply from selected provider."));
  }).pipe(Effect.provide(h.layer));
});
it.effect(
  "commits a reply and its delivery atomically, then deduplicates checkpoint retries",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const deliveries = yield* DeliveryStore.DeliveryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* deliveries.bind("source", "personal-telegram", {
        type: "telegram",
        chatId: "42",
        messageId: 5,
      });
      yield* sql`CREATE TRIGGER fail_delivery BEFORE INSERT ON connector_deliveries BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END`;
      assert.equal(
        (yield* store.append("reply", "assistant", "Reply", "source").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* store.snapshot()).messages.length, 0);
      yield* sql`DROP TRIGGER fail_delivery`;
      yield* store.append("reply", "assistant", "Reply", "source");
      yield* store.append("reply", "assistant", "Reply", "source");
      assert.equal((yield* sql`SELECT id FROM connector_deliveries`).length, 1);
      assert.equal((yield* store.snapshot()).messages.length, 1);
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect("delivers a recurring reminder to the connector that created its responsibility", () => {
  const h = harness();
  return Effect.gen(function* () {
    const store = yield* Store.Store;
    const deliveries = yield* DeliveryStore.DeliveryStore;
    const coordinator = yield* Coordinator.Coordinator;
    const connectors = yield* Connectors.Connectors;
    yield* deliveries.bind("origin", "personal-telegram", {
      type: "telegram",
      chatId: "42",
      messageId: 5,
    });
    yield* store.command(
      {
        type: "responsibility.save",
        requestId: "save-r",
        id: "r",
        revision: 0,
        title: "Reminder",
        instructions: "Check progress",
        environmentId: null,
        projectId: null,
        schedule: { type: "interval", everyMs: 60000 },
      },
      undefined,
      undefined,
      "origin",
    );
    yield* TestClock.adjust("60 seconds");
    yield* store.tick();
    const occurrence = yield* store.claim();
    assert.ok(occurrence);
    assert.equal(yield* coordinator.run(occurrence), true);
    yield* store.finish(occurrence);
    yield* answer;
    yield* connectors.step;
    assert.equal(h.sent[0]?.body.chat_id, "42");
    assert.equal(h.sent[0]?.body.text, "Here is the evidence.");
  }).pipe(Effect.provide(h.layer));
});
