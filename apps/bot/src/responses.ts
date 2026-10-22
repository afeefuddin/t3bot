import { stableId } from "@t3tools/shared/stableId";
import type { BotChatMessage } from "@t3tools/contracts/bot";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BotTool } from "./Model.ts";
import { BotError, type ProviderConfig } from "./config.ts";

type HttpProvider = Extract<ProviderConfig, { endpoint: string }>;
const Text = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("output_text"),
    text: Schema.String,
    annotations: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  }),
  Schema.Struct({ type: Schema.Literal("refusal"), refusal: Schema.String }),
]);
const Item = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("web_search_call"),
    id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    action: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    encrypted_content: Schema.optional(Schema.String),
    summary: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.Literal("assistant"),
    content: Schema.Array(Text),
    phase: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("function_call"),
    call_id: Schema.String.check(Schema.isMinLength(1)),
    name: Schema.String.check(Schema.isMinLength(1)),
    arguments: Schema.String,
  }),
]);
const Response = Schema.Struct({
  status: Schema.String,
  output: Schema.Array(Item),
  usage: Schema.optional(
    Schema.Struct({ total_tokens: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) }),
  ),
  incomplete_details: Schema.optional(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
});
const decodeResponse = Schema.decodeUnknownEffect(Response);

function issuer(provider: HttpProvider): string {
  return stableId("responses", provider.id, provider.endpoint, provider.model);
}

export function responsesRequest(
  provider: HttpProvider,
  messages: ReadonlyArray<BotChatMessage>,
  tools: ReadonlyArray<BotTool>,
) {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      });
    } else if (message.role === "assistant") {
      if (message.responseState?.issuer === issuer(provider)) {
        input.push(...message.responseState.output);
        continue;
      }
      if (message.content) input.push({ role: "assistant", content: message.content });
      for (const call of message.tool_calls ?? [])
        input.push({ type: "function_call", call_id: call.id, ...call.function });
    } else input.push({ role: message.role, content: message.content ?? "" });
  }
  return {
    model: provider.model,
    instructions: messages
      .filter((m) => m.role === "system")
      .map((m) => m.content ?? "")
      .join("\n\n"),
    input,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 4096,
    ...(provider.reasoningEffort ? { reasoning: { effort: provider.reasoningEffort } } : {}),
    ...(tools.length || provider.webSearch
      ? {
          tools: [
            ...tools.map((tool) => ({ type: "function", ...tool.function, strict: false })),
            ...(provider.webSearch ? [{ type: "web_search" }] : []),
          ],
          parallel_tool_calls: false,
        }
      : {}),
  };
}

export const responsesResult = Effect.fn(function* (
  provider: HttpProvider,
  body: unknown,
  tools: ReadonlyArray<BotTool>,
) {
  const response = yield* decodeResponse(body).pipe(
    Effect.mapError((cause) => new BotError({ category: "invalid", cause })),
  );
  if (response.status !== "completed")
    return yield* new BotError({
      category:
        response.incomplete_details?.reason === "max_output_tokens" ? "budget" : "unavailable",
    });
  const calls = response.output.filter((item) => item.type === "function_call");
  if (calls.length > 4) return yield* new BotError({ category: "budget" });
  if (
    new Set(calls.map((call) => call.call_id)).size !== calls.length ||
    calls.some((call) => !tools.some((tool) => tool.function.name === call.name))
  )
    return yield* new BotError({ category: "invalid" });
  let content = response.output
    .flatMap((item) =>
      item.type === "message"
        ? item.content.map((part) => (part.type === "output_text" ? part.text : part.refusal))
        : [],
    )
    .join("\n");
  const citations = new Map<string, string>();
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type !== "output_text") continue;
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
        const url = URL.parse(annotation.url);
        if (!url || !["http:", "https:"].includes(url.protocol) || content.includes(url.href))
          continue;
        const title = typeof annotation.title === "string" ? annotation.title : url.hostname;
        citations.set(
          url.href,
          `[${title.replace(/[[\]\r\n]/g, " ")}](<${url.href.replace(/>/g, "%3E")}>)`,
        );
      }
    }
  }
  if (citations.size) content += `\n\nSources: ${[...citations.values()].join(" · ")}`;
  if (!content && !calls.length) return yield* new BotError({ category: "invalid" });
  // Stateless replay carries encrypted reasoning, never references to server-stored item IDs.
  const output = response.output.filter(
    (item) => item.type !== "reasoning" || item.encrypted_content,
  );
  const message: BotChatMessage = {
    role: "assistant",
    content: content || null,
    ...(calls.length
      ? {
          tool_calls: calls.map((call) => ({
            id: call.call_id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
    responseState: { issuer: issuer(provider), output },
  };
  return { message, tokens: response.usage?.total_tokens };
});
