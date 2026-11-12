/**
 * Transport tests.
 *
 * Retry and error-mapping logic is the part of an SDK that is hardest to trust
 * by reading, because the interesting paths only run when something fails. These
 * drive each one with an injected fetch.
 *
 *   npm run build && node --test dist/client.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { VerafyClient } from "./client.js";
import {
  VerafyAuthError,
  VerafyCreditsError,
  VerafyRateLimitError,
  VerafyTimeoutError,
  VerafyUpstreamError,
  VerafyValidationError,
} from "./errors.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/** A fetch that replays a queued list of responses and records the calls. */
function stubFetch(responses: Array<{ status: number; body?: unknown; text?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, {
      status: r.status,
      headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls, callCount: () => calls.length };
}

const client = (f: typeof fetch, over: Partial<ConstructorParameters<typeof VerafyClient>[0]> = {}) =>
  new VerafyClient({ apiKey: "test-key", fetchImpl: f, attempts: 3, ...over });

test("sends the key as X-API-Key and returns parsed data", async () => {
  const s = stubFetch([{ status: 200, body: { apiKeyId: "k1", credits: 490 } }]);
  const { data, status, attempts } = await client(s.impl).credits();

  assert.equal(data.credits, 490);
  assert.equal(status, 200);
  assert.equal(attempts, 1);
  assert.equal((s.calls[0].init.headers as Record<string, string>)["X-API-Key"], "test-key");
});

test("surfaces rate limit headers on a success", async () => {
  const resetAt = Math.ceil(Date.now() / 1000) + 3600;
  const s = stubFetch([
    {
      status: 200,
      body: { apiKeyId: "k1", credits: 10 },
      headers: { "X-RateLimit-Remaining": "97", "X-RateLimit-Reset": String(resetAt) },
    },
  ]);
  const { rateLimit } = await client(s.impl).credits();
  assert.equal(rateLimit?.remaining, 97);
  assert.equal(rateLimit?.resetAt, resetAt);
});

test("a 401 throws VerafyAuthError and is never retried", async () => {
  const s = stubFetch([{ status: 401, body: { error: "Invalid API key" } }]);
  await assert.rejects(() => client(s.impl).credits(), (e: unknown) => {
    assert.ok(e instanceof VerafyAuthError);
    assert.equal(e.retryable, false);
    return true;
  });
  assert.equal(s.callCount(), 1, "an auth failure must not be retried");
});

test("a 403 throws VerafyCreditsError carrying the figures", async () => {
  const s = stubFetch([{ status: 403, body: { error: "Insufficient credits", required: 5, credits: 2 } }]);
  await assert.rejects(
    () => client(s.impl).broadcastQuery({ queryText: "is the sky blue?", queriesRequested: 5 }),
    (e: unknown) => {
      assert.ok(e instanceof VerafyCreditsError);
      assert.equal(e.required, 5);
      assert.equal(e.available, 2);
      return true;
    },
  );
  assert.equal(s.callCount(), 1, "a credit failure must not be retried");
});

test("a 429 is retried once the reset time passes, then succeeds", async () => {
  const resetAt = Math.ceil((Date.now() + 40) / 1000);
  const s = stubFetch([
    { status: 429, body: { error: "Rate limit exceeded" }, headers: { "X-RateLimit-Reset": String(resetAt) } },
    { status: 200, body: { apiKeyId: "k1", credits: 1 } },
  ]);
  const { data, attempts } = await client(s.impl).credits();
  assert.equal(data.credits, 1);
  assert.equal(attempts, 2);
});

test("a 429 whose reset is beyond maxRetryWaitMs throws instead of hanging", async () => {
  const resetAt = Math.ceil(Date.now() / 1000) + 3600;
  const s = stubFetch([{ status: 429, body: { error: "Rate limit exceeded" }, headers: { "X-RateLimit-Reset": String(resetAt) } }]);
  await assert.rejects(() => client(s.impl, { maxRetryWaitMs: 1000 }).credits(), (e: unknown) => {
    assert.ok(e instanceof VerafyRateLimitError);
    assert.ok(e.retryAfterMs > 1000);
    return true;
  });
  assert.equal(s.callCount(), 1, "the client must not sleep for an hour");
});

test("a 500 is retried and the attempt count is reported", async () => {
  const s = stubFetch([
    { status: 500, body: { error: "boom" } },
    { status: 503, body: { error: "boom" } },
    { status: 200, body: { apiKeyId: "k1", credits: 7 } },
  ]);
  const { data, attempts } = await client(s.impl).credits();
  assert.equal(data.credits, 7);
  assert.equal(attempts, 3);
});

test("a 200 carrying HTML becomes VerafyUpstreamError after retries", async () => {
  const s = stubFetch([{ status: 200, text: "<!DOCTYPE html><html>gateway</html>" }]);
  await assert.rejects(() => client(s.impl, { attempts: 2 }).credits(), (e: unknown) => {
    assert.ok(e instanceof VerafyUpstreamError);
    assert.match(e.message, /HTML/);
    return true;
  });
  assert.equal(s.callCount(), 2);
});

test("a timeout becomes VerafyTimeoutError", async () => {
  const hang = (async (_u: unknown, init: RequestInit = {}) =>
    new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    })) as unknown as typeof fetch;

  await assert.rejects(() => client(hang, { timeoutMs: 20, attempts: 1 }).credits(), (e: unknown) => {
    assert.ok(e instanceof VerafyTimeoutError);
    assert.equal(e.timeoutMs, 20);
    return true;
  });
});

test("client-side validation fires before any request is made", async () => {
  const s = stubFetch([{ status: 200, body: {} }]);
  const c = client(s.impl);

  await assert.rejects(() => c.broadcastQuery({ queryText: "   " }), VerafyValidationError);
  await assert.rejects(() => c.broadcastQuery({ queryText: "x".repeat(1001) }), VerafyValidationError);
  await assert.rejects(() => c.broadcastQuery({ queryText: "ok", selectedLLMIds: ["not-a-uuid"] }), VerafyValidationError);
  await assert.rejects(() => c.broadcastQuery({ queryText: "ok", queriesRequested: 21 }), VerafyValidationError);
  await assert.rejects(() => c.validator("nope"), VerafyValidationError);

  assert.equal(s.callCount(), 0, "nothing should reach the network");
});

test("costOf matches the server: one credit per model", () => {
  assert.equal(VerafyClient.costOf({ queryText: "q" }), 1);
  assert.equal(VerafyClient.costOf({ queryText: "q", queriesRequested: 7 }), 7);
  assert.equal(VerafyClient.costOf({ queryText: "q", selectedLLMIds: [UUID_A, UUID_B] }), 2);
  // Named validators win over the count, as the server does.
  assert.equal(VerafyClient.costOf({ queryText: "q", queriesRequested: 9, selectedLLMIds: [UUID_A] }), 1);
});

test("validators() normalizes a bare array and a wrapped one", async () => {
  const one = [{ id: UUID_A, profileName: "a", provider: "openai", modelName: "m" }];

  const bare = await client(stubFetch([{ status: 200, body: one }]).impl).validators();
  assert.equal(bare.data.length, 1);

  const wrapped = await client(stubFetch([{ status: 200, body: { validators: one } }]).impl).validators();
  assert.equal(wrapped.data.length, 1);

  const odd = await client(stubFetch([{ status: 200, body: { nothing: true } }]).impl).validators();
  assert.deepEqual(odd.data, [], "an unrecognized shape yields an empty list, not a crash");
});

test("broadcastMany stops on exhausted credits instead of burning the rest", async () => {
  let n = 0;
  const impl = (async () => {
    n++;
    if (n <= 1) return new Response(JSON.stringify({ id: "r1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const reqs = Array.from({ length: 8 }, (_, i) => ({ queryText: `question ${i}` }));
  const out = await client(impl).broadcastMany(reqs, { concurrency: 1 });

  assert.equal(out[0].result?.data.id, "r1");
  assert.ok(out[1].error instanceof VerafyCreditsError);
  const attempted = out.filter((o) => o.result || o.error).length;
  assert.ok(attempted < reqs.length, `halted after ${attempted} of ${reqs.length}`);
  assert.equal(out.length, reqs.length, "every input still has an entry, in order");
});

test("constructing without a key fails loudly", () => {
  const saved = process.env.VERAFY_API_KEY;
  delete process.env.VERAFY_API_KEY;
  try {
    assert.throws(() => new VerafyClient(), /VERAFY_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.VERAFY_API_KEY = saved;
  }
});
