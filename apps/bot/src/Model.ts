import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import { completeCodex } from "./codex.ts";
import { serialize } from "./json.ts";
import { responsesRequest, responsesResult } from "./responses.ts";
import { BotModelResponse, type BotChatMessage } from "@t3tools/contracts/bot";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { BotConfig, BotError, isBotError } from "./config.ts";

export interface BotTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export class Model extends Context.Service<
  Model,
  {
    readonly complete: (
      provider: string,
      messages: ReadonlyArray<BotChatMessage>,
      tools: ReadonlyArray<BotTool>,
    ) => Effect.Effect<{ message: BotChatMessage; tokens: number }, BotError>;
  }
>()("@t3tools/bot/Model") {}

const make = Effect.gen(function* () {
  const config = yield* BotConfig;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  return Model.of({
    complete: (id, messages, tools) =>
      Effect.gen(function* () {
        const provider = config.providers.find((p) => p.id === id);
        if (!provider) return yield* new BotError({ category: "invalid" });
        const chatMessages = messages.map((message) => ({
          role: message.role,
          content: message.content,
          tool_calls: message.tool_calls,
          tool_call_id: message.tool_call_id,
        }));
        if ("type" in provider)
          return yield* completeCodex(provider, chatMessages, tools).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
          );
        const body =
          provider.api === "responses"
            ? responsesRequest(provider, messages, tools)
            : {
                model: provider.model,
                messages: chatMessages,
                ...(tools.length ? { tools } : {}),
                [provider.maxTokensField ?? "max_completion_tokens"]: 4096,
              };
        const request = HttpClientRequest.post(provider.endpoint).pipe(
          HttpClientRequest.setHeaders(
            provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
          ),
          HttpClientRequest.bodyJsonUnsafe(body),
        );
        const response = yield* http.execute(request);
        if (response.status < 200 || response.status >= 300)
          return yield* new BotError({
            category:
              response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable",
          });
        if (provider.api === "responses") {
          const result = yield* responsesResult(provider, yield* response.json, tools);
          return {
            ...result,
            tokens: result.tokens ?? Math.ceil(serialize(body).length / 3) + 4096,
          };
        }
        const decoded = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(BotModelResponse)),
        );
        const message = decoded.choices[0]?.message;
        if (
          !message ||
          message.role !== "assistant" ||
          (!message.content && !message.tool_calls?.length)
        )
          return yield* new BotError({ category: "invalid" });
        if ((message.tool_calls?.length ?? 0) > 4)
          return yield* new BotError({ category: "budget" });
        return {
          message,
          tokens: decoded.usage?.total_tokens ?? Math.ceil(serialize(messages).length / 3) + 4096,
        };
      }).pipe(
        Effect.timeout("70 seconds"),
        Effect.mapError((cause) =>
          isBotError(cause) ? cause : new BotError({ category: "unavailable", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(Model, make);
