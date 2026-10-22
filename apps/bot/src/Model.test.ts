import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotChatMessage } from "@t3tools/contracts/bot";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { BotConfig, type ProviderConfig } from "./config.ts";
import * as Model from "./Model.ts";
import * as Coordinator from "./Coordinator.ts";
import * as Store from "./Store.ts";
import * as Database from "./database.ts";

const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(BotChatMessage));

const provider = {
  id: "Codex",
  endpoint: "https://model.invalid/v1/responses",
  model: "codex-test",
  api: "responses",
  reasoningEffort: "high",
} as const;
const tool = {
  type: "function",
  function: {
    name: "remember",
    description: "Save memory",
    parameters: { type: "object", properties: {} },
  },
} as const;
const reasoning = {
  type: "reasoning",
  id: "rs_not_stored",
  summary: [],
  encrypted_content: "opaque-continuation",
};
const call = {
  type: "function_call",
  id: "fc_not_stored",
  call_id: "call_1",
  name: "remember",
  arguments: JSON.stringify({
    id: "project",
    revision: 0,
    scope: "user",
    text: "The project is t3bot",
    explicit: true,
  }),
};
const answer = {
  type: "message",
  role: "assistant",
  id: "msg_not_stored",
  content: [{ type: "output_text", text: "Remembered." }],
};
const response = (output: unknown[]) => ({
  status: "completed",
  output,
  usage: { total_tokens: 100 },
});

function harness(
  replies: Array<{ body: unknown; status?: number }>,
  providers: ReadonlyArray<ProviderConfig> = [provider],
) {
  const requests: Array<{
    url: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        assert.equal(request.body._tag, "Uint8Array");
        const body =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
            : {};
        requests.push({ url: request.url, authorization: request.headers.authorization, body });
        const reply = replies.shift();
        assert.ok(reply, "Unexpected model request");
        return HttpClientResponse.fromWeb(
          request,
          Response.json(reply.body, { status: reply.status ?? 200 }),
        );
      }),
    ),
  );
  const config = Layer.succeed(
    BotConfig,
    BotConfig.of({
      provider: provider.id,
      providers: providers.map((p) => ({ ...p, apiKey: "test-private-key" })),
    }),
  );
  return {
    requests,
    layer: Model.layer.pipe(
      Layer.provideMerge(http),
      Layer.provideMerge(config),
      Layer.provide(NodeServices.layer),
    ),
  };
}

it.effect("calls Responses directly and replays durable reasoning with native tool results", () => {
  const h = harness([{ body: response([reasoning, call]) }, { body: response([answer]) }]);
  return Effect.gen(function* () {
    const model = yield* Model.Model;
    const first = yield* model.complete(
      "Codex",
      [
        { role: "system", content: "You are t3bot." },
        { role: "user", content: "Remember the project" },
      ],
      [tool],
    );
    assert.equal(first.message.tool_calls?.[0]?.id, "call_1");
    assert.equal(first.tokens, 100);
    // Exercise the same JSON/schema boundary used when a worker resumes a saved turn.
    const persisted = yield* decodeMessage(JSON.stringify(first.message));
    const second = yield* model.complete(
      "Codex",
      [
        { role: "user", content: "Remember the project" },
        persisted,
        { role: "tool", tool_call_id: "call_1", content: '{"saved":true}' },
      ],
      [tool],
    );
    assert.equal(second.message.content, "Remembered.");
    assert.equal(h.requests[0]?.url, provider.endpoint);
    assert.equal(h.requests[0]?.authorization, "Bearer test-private-key");
    assert.equal(h.requests[0]?.body.instructions, "You are t3bot.");
    assert.deepEqual(h.requests[0]?.body.reasoning, { effort: "high" });
    assert.equal(h.requests[0]?.body.store, false);
    assert.deepEqual(h.requests[0]?.body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(h.requests[1]?.body.input, [
      { role: "user", content: "Remember the project" },
      { type: "reasoning", summary: [], encrypted_content: "opaque-continuation" },
      { type: "function_call", call_id: "call_1", name: "remember", arguments: call.arguments },
      { type: "function_call_output", call_id: "call_1", output: '{"saved":true}' },
    ]);
    assert.notProperty(h.requests[1]?.body, "previous_response_id");
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "resumes a saved API decision after checkpoint failure without repeating the memory action",
  () => {
    const h = harness([{ body: response([reasoning, call]) }, { body: response([answer]) }]);
    const layer = Coordinator.layer.pipe(
      Layer.provideMerge(Store.layer),
      Layer.provide(h.layer),
      Layer.provideMerge(Database.layer(":memory:")),
    );
    return Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      yield* store.command({
        type: "message",
        requestId: "remember",
        text: "Remember the project",
      });
      const job = yield* store.claim();
      assert.ok(job);
      yield* sql`CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF messages ON turns BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END`;
      assert.equal((yield* coordinator.run(job).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* store.snapshot()).memories[0]?.revision, 1);
      yield* sql`DROP TRIGGER fail_checkpoint`;
      assert.equal(yield* coordinator.run(job), false);
      assert.equal(h.requests.length, 1);
      const next = yield* store.claim();
      assert.ok(next);
      assert.equal(yield* coordinator.run(next), true);
      yield* store.finish(next);
      assert.equal(h.requests.length, 2);
      assert.equal((yield* store.snapshot()).memories[0]?.revision, 1);
      assert.equal((yield* store.snapshot()).messages.at(-1)?.text, "Remembered.");
      assert.include(JSON.stringify(h.requests[1]?.body.input), "opaque-continuation");
      assert.include(JSON.stringify(h.requests[1]?.body.input), "function_call_output");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("switches providers without forwarding another issuer's encrypted state", () => {
  const alternative = { ...provider, id: "other", endpoint: "https://other.invalid/responses" };
  const chat = { id: "chat", endpoint: "https://other.invalid/chat/completions", model: "chat" };
  const h = harness(
    [
      { body: response([reasoning, call]) },
      { body: response([answer]) },
      { body: { choices: [{ message: { role: "assistant", content: "Chat works" } }] } },
    ],
    [provider, alternative, chat],
  );
  return Effect.gen(function* () {
    const model = yield* Model.Model;
    const first = yield* model.complete("Codex", [{ role: "user", content: "Remember" }], [tool]);
    const history = [
      first.message,
      { role: "tool" as const, tool_call_id: "call_1", content: "saved" },
    ];
    yield* model.complete("other", history, [tool]);
    yield* model.complete("chat", history, [tool]);
    assert.notInclude(JSON.stringify(h.requests[1]?.body), "opaque-continuation");
    assert.notInclude(JSON.stringify(h.requests[2]?.body), "responseState");
    assert.include(JSON.stringify(h.requests[1]?.body), "function_call_output");
    assert.equal(h.requests[2]?.body.model, "chat");
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  { name: "unauthorized", body: {}, status: 401, category: "unauthorized" },
  { name: "rate limit", body: {}, status: 429, category: "unavailable" },
  {
    name: "truncated tool arguments",
    body: {
      status: "incomplete",
      output: [call],
      incomplete_details: { reason: "max_output_tokens" },
    },
    category: "budget",
  },
  { name: "unknown tool", body: response([{ ...call, name: "shell" }]), category: "invalid" },
  { name: "duplicate call ids", body: response([call, call]), category: "invalid" },
  {
    name: "too many tools",
    body: response(Array.from({ length: 5 }, (_, i) => ({ ...call, call_id: `call_${i}` }))),
    category: "budget",
  },
  { name: "no answer", body: response([reasoning]), category: "invalid" },
])("rejects $name before executing tools", (reply) => {
  const h = harness([reply]);
  return Effect.gen(function* () {
    const model = yield* Model.Model;
    const result = yield* model
      .complete("Codex", [{ role: "user", content: "Test" }], [tool])
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.category, reply.category);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "uses configurable native web search and preserves search evidence across model steps",
  () => {
    const search = {
      type: "web_search_call",
      id: "search-1",
      status: "completed",
      action: { type: "search", query: "public information" },
    };
    const h = harness(
      [
        {
          body: response([
            search,
            {
              ...answer,
              content: [
                {
                  type: "output_text",
                  text: "Remembered.",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.com/evidence",
                      title: "Evidence",
                      start_index: 0,
                      end_index: 11,
                    },
                  ],
                },
              ],
            },
          ]),
        },
        { body: response([answer]) },
      ],
      [{ ...provider, webSearch: true }],
    );
    return Effect.gen(function* () {
      const model = yield* Model.Model;
      const first = yield* model.complete(
        "Codex",
        [{ role: "user", content: "Find current public information" }],
        [tool],
      );
      assert.deepEqual(h.requests[0]?.body.tools, [
        { type: "function", ...tool.function, strict: false },
        { type: "web_search" },
      ]);
      assert.include(first.message.content!, "Remembered.");
      assert.include(first.message.content!, "[Evidence](<https://example.com/evidence>)");
      const saved = yield* decodeMessage(JSON.stringify(first.message));
      yield* model.complete(
        "Codex",
        [
          { role: "user", content: "Find current public information" },
          saved,
          { role: "user", content: "Explain the evidence" },
        ],
        [tool],
      );
      assert.include(JSON.stringify(h.requests[1]?.body.input), "web_search_call");
      assert.include(JSON.stringify(h.requests[1]?.body.input), "url_citation");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each([false, true])(
  "enables native search only when configured, even without function tools (%s)",
  (webSearch) => {
    const h = harness([{ body: response([answer]) }], [{ ...provider, webSearch }]);
    return Effect.gen(function* () {
      const model = yield* Model.Model;
      yield* model.complete("Codex", [{ role: "user", content: "Look this up" }], []);
      if (webSearch) assert.deepEqual(h.requests[0]?.body.tools, [{ type: "web_search" }]);
      else assert.notProperty(h.requests[0]?.body, "tools");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("deduplicates source links and ignores invalid citation URLs", () => {
  const citation = {
    type: "url_citation",
    title: "Official [source]",
    url: "https://example.com/evidence",
  };
  const h = harness([
    {
      body: response([
        {
          ...answer,
          content: [
            {
              type: "output_text",
              text: "Evidence.",
              annotations: [
                citation,
                citation,
                { ...citation, url: "javascript:alert(1)" },
                { ...citation, url: "invalid url" },
              ],
            },
          ],
        },
      ]),
    },
  ]);
  return Effect.gen(function* () {
    const model = yield* Model.Model;
    const result = yield* model.complete("Codex", [{ role: "user", content: "Look this up" }], []);
    const text = result.message.content ?? "";
    assert.equal(text.split("https://example.com/evidence").length, 2);
    assert.notInclude(text, "javascript:");
    assert.notInclude(text, "invalid url");
  }).pipe(Effect.provide(h.layer));
});
