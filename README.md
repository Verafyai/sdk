# @verafy/sdk

TypeScript SDK for the [Verafy](https://verafy.ai) public API. Broadcast a question to a swarm of language models and read back every vote, with the consensus and each model's reasoning.

The client has no runtime dependencies: it uses the platform's `fetch` and `AbortController` and nothing else. Node 20+. MIT.

The MCP server is a separate entry point and needs `@modelcontextprotocol/sdk`, declared as an optional peer so a plain install of the client stays dependency-free.

```bash
npm install @verafy/sdk
```

```ts
import { VerafyClient } from "@verafy/sdk";

const verafy = new VerafyClient({ apiKey: process.env.VERAFY_API_KEY! });

const { data, rateLimit } = await verafy.broadcastQuery({
  queryText: "Did the 2024 Atlantic hurricane season have above-average activity?",
  queryMode: "fact-check",
  queriesRequested: 5,
});

for (const v of data.responses ?? []) {
  console.log(`${v.profileName}: ${v.vote} — ${v.rationale}`);
}
console.log(`${rateLimit?.remaining} requests left this hour`);
```

## Credits are per model, not per request

This is the single thing most likely to surprise a new caller. Asking five validators costs five credits, not one. A new key starts with 500, so a loop that asks twenty models drains it in twenty-five iterations.

`costOf` computes the cost the same way the server does, so you can check before spending:

```ts
const request = { queryText: "...", queriesRequested: 10 };

const cost = VerafyClient.costOf(request);      // 10
const { data } = await verafy.credits();

if (data.credits < cost) {
  throw new Error(`need ${cost} credits, have ${data.credits}`);
}
await verafy.broadcastQuery(request);
```

Named validators take precedence over the count, matching the server: `{ queriesRequested: 9, selectedLLMIds: [oneId] }` costs 1, not 9.

## Choosing validators

```ts
const { data: validators } = await verafy.activeValidators();

const panel = validators
  .filter((v) => v.provider !== "openai")        // keep a vendor off its own question
  .sort((a, b) => (b.reliability ?? 0) - (a.reliability ?? 0))
  .slice(0, 5);

await verafy.broadcastQuery({
  queryText: "...",
  selectedLLMIds: panel.map((v) => v.id),
});
```

`reliability` is `correctVotes / totalVotes` from past rulings and is `null` until a validator has voted, so sort defensively as above rather than assuming a number.

## Errors you can act on

The API distinguishes four failures a caller handles differently, and collapsing them into one `Error` forces every caller to parse a string. Each is its own class, carrying the fields you need:

```ts
import {
  VerafyAuthError,
  VerafyCreditsError,
  VerafyRateLimitError,
  VerafyValidationError,
} from "@verafy/sdk";

try {
  await verafy.broadcastQuery({ queryText: q, queriesRequested: 5 });
} catch (e) {
  if (e instanceof VerafyCreditsError) {
    // Knows the shortfall, so you can top up by the right amount.
    await topUp(e.required! - e.available!);
  } else if (e instanceof VerafyRateLimitError) {
    // Knows when the window resets, so you can wait the right length of time.
    await sleep(e.retryAfterMs);
  } else if (e instanceof VerafyAuthError) {
    throw e;                                      // retrying never helps
  } else if (e instanceof VerafyValidationError) {
    console.error(e.details);                     // field-level detail
  }
}
```

`VerafyError.retryable` lets you branch without knowing the subclasses.

## What the client handles for you

**Retries, selectively.** Three attempts by default on 408, 429 and 5xx. A 401 or 403 is never retried: retrying an auth failure wastes your time and looks like a brute-force attempt from the server side.

**Rate limits, precisely.** A 429 carries `X-RateLimit-Reset`, so the client waits until that moment rather than backing off blindly. If the reset is further out than `maxRetryWaitMs` (65 seconds by default) it throws instead, with `resetAt` attached, so your process decides whether to wait an hour rather than silently hanging for one.

**HTML from upstream.** The API proxies the swarm, and when that proxy fails you get a 200 carrying an HTML error page. The client detects it and raises `VerafyUpstreamError`, retrying first, instead of handing you a parse failure from inside your own code.

**Validation before the network.** A blank query, a 1,001-character query, 21 validator ids, a non-UUID id: each throws `VerafyValidationError` without a request. The server's 400 costs a round trip and tells you less.

**Two response shapes.** The validators endpoints have returned both a bare array and an object wrapping one. `validators()` normalizes both, and returns `[]` for a shape it does not recognize rather than crashing in your loop.

**Rate limit state on every call.** `rateLimit` comes back on success as well as failure, so a batch job can pace itself instead of discovering the limit by hitting it.

## Batching

`broadcastMany` runs several queries with bounded concurrency and stops as soon as credits run out, rather than burning the remaining calls on 403s:

```ts
const out = await verafy.broadcastMany(
  questions.map((queryText) => ({ queryText, queriesRequested: 3 })),
  { concurrency: 3 },
);

const answered = out.filter((o) => o.result);
const halted = out.find((o) => o.error?.name === "VerafyCreditsError");
if (halted) console.warn(`stopped after ${answered.length} of ${questions.length}`);
```

Every input gets an entry in input order, each either a `result` or the `error` that query hit, so one bad query does not lose the batch.

## Configuration

```ts
new VerafyClient({
  apiKey: process.env.VERAFY_API_KEY!,   // or VERAFY_API_KEY in the environment
  baseUrl: "https://api.verafy.ai",      // or VERAFY_BASE_URL
  attempts: 3,
  timeoutMs: 120_000,                    // a swarm query fans out to many models
  maxRetryWaitMs: 65_000,
  headers: {},
  fetchImpl: fetch,                      // injected for tests
});
```

The 120-second default is deliberate. A broadcast to twenty models waits on the slowest of twenty, and a 30-second timeout fails requests that would have succeeded.

## API

| | |
|---|---|
| `broadcastQuery(req)` | Send one question to the swarm. Costs one credit per model |
| `broadcastMany(reqs, opts)` | Several queries, bounded concurrency, stops when credits run out |
| `credits()` | Credits left on the key, and when it was last used |
| `validators()` | Every validator the swarm knows |
| `activeValidators()` | Only those able to vote now. Use this to build `selectedLLMIds` |
| `validator(id)` | One validator: model, provider, reliability, vote history |
| `costOf(req)` | Credits a broadcast will cost. Static or instance |

Every method returns `{ data, rateLimit, status, attempts }`. `attempts` is 1 when no retry was needed, which is worth logging in a batch job.

## MCP server

The same API, inside Claude Code, Cursor, Codex and Gemini CLI.

```json
{
  "mcpServers": {
    "verafy": {
      "command": "npx",
      "args": ["-y", "@verafy/sdk/mcp"],
      "env": { "VERAFY_API_KEY": "..." }
    }
  }
}
```

| Tool | |
|---|---|
| `verafy_validators` | List validators, filter by provider, active only |
| `verafy_validator` | One validator in full |
| `verafy_credits` | Balance on the key |
| `verafy_cost` | Price a broadcast and say whether the key can afford it. Spends nothing |
| `verafy_broadcast` | Ask a panel. **Spends credits.** Requires `confirm: true` |

`verafy_broadcast` checks the balance first and fails with the shortfall rather than spending down to zero and then erroring, and every result reports credits spent and remaining so the agent's own context carries the budget. An agent holding a key should not be able to drain it because a tool looked harmless.

## Getting a key

There is no self-serve signup yet. Keys are issued by the Verafy API maintainer, who sets the initial credit balance.

## Tests

```bash
npm run build && npm test
```

Fourteen tests, all against an injected fetch, covering each retry and error path: the 401 that must not be retried, the 429 honored to its reset, the 429 whose reset is too far out, the 200 carrying HTML, the timeout, the validation that fires before the network, and the batch that halts on exhausted credits.

The retry logic is the part of an SDK hardest to trust by reading, because the interesting paths only run when something fails. One of these tests caught a real control-flow bug during development: an error thrown from inside the request `try` was being caught by the same `catch` that decides retryability, so a 429 the client had decided *not* to wait out got retried anyway, three times, ignoring `maxRetryWaitMs`.
