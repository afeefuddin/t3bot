import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { fetchPage } from "./web.ts";

it.effect("retrieves arbitrary text and HTML sources with provenance and bounded content", () => {
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          `<html><script>untrusted code</script><body><a href="https://example.com/source">Evidence</a> ${"detail ".repeat(4000)}</body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const result = yield* fetchPage("https://example.com/research");
    assert.equal(result.url, "https://example.com/research");
    assert.include(result.text, "Evidence (https://example.com/source)");
    assert.notInclude(result.text, "untrusted code");
    assert.equal(result.text.length, 16000);
    assert.equal(result.truncated, true);
    assert.equal((yield* fetchPage("file:///etc/passwd").pipe(Effect.result))._tag, "Failure");
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  {
    name: "non-http URL",
    url: "file:///etc/passwd",
    status: 200,
    type: "text/plain",
    body: "private",
    category: "invalid",
  },
  {
    name: "embedded credentials",
    url: "https://user:password@example.com",
    status: 200,
    type: "text/plain",
    body: "private",
    category: "invalid",
  },
  {
    name: "unsuccessful response",
    url: "https://example.com",
    status: 503,
    type: "text/plain",
    body: "unavailable",
    category: "unavailable",
  },
  {
    name: "binary response",
    url: "https://example.com",
    status: 200,
    type: "image/png",
    body: "binary",
    category: "invalid",
  },
  {
    name: "oversized response",
    url: "https://example.com",
    status: 200,
    type: "text/plain",
    body: "x".repeat(1024 * 1024 + 1),
    category: "unavailable",
  },
])("rejects $name", (test) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      calls++;
      return HttpClientResponse.fromWeb(
        request,
        new Response(test.body, { status: test.status, headers: { "content-type": test.type } }),
      );
    }),
  );
  return Effect.gen(function* () {
    const result = yield* fetchPage(test.url).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.category, test.category);
    assert.equal(calls, test.url.includes("password") || test.url.startsWith("file:") ? 0 : 1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("bounds a stalled request with the clock and interrupts the fetch", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const http = HttpClient.make(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    );
    const fiber = yield* Effect.forkScoped(
      fetchPage("https://example.com").pipe(
        Effect.result,
        Effect.provideService(HttpClient.HttpClient, http),
      ),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("9 seconds");
    const result = yield* Fiber.join(fiber);
    assert.equal(result._tag, "Failure");
    yield* Deferred.await(stopped);
  }),
);
