/**
 * VerafyClient — the Verafy public API, typed.
 *
 * Zero runtime dependencies; native fetch and AbortController only.
 *
 *   const verafy = new VerafyClient({ apiKey: process.env.VERAFY_API_KEY! });
 *
 *   const { data, rateLimit } = await verafy.broadcastQuery({
 *     queryText: "Did the 2024 Atlantic hurricane season have above-average activity?",
 *     queryMode: "fact-check",
 *     queriesRequested: 5,
 *   });
 *
 * Three behaviors the API makes a caller handle, which this handles for them:
 *
 * 1. **Credits are per model, not per request.** Asking five validators costs
 *    five credits. `broadcastQuery` computes the cost the same way the server
 *    does and exposes it as `costOf()`, so a caller can check before spending.
 * 2. **429 carries a reset time.** The client waits until that time rather than
 *    backing off blindly, and only for as long as `maxRetryWaitMs` allows.
 * 3. **An auth or credit failure is never retried.** Retrying a 401 wastes the
 *    caller's time and can look like a brute-force attempt from the server side.
 */

import {
  VerafyError,
  VerafyTimeoutError,
  VerafyRateLimitError,
  VerafyUpstreamError,
  VerafyValidationError,
  errorFor,
} from "./errors.js";
import type {
  BroadcastQueryRequest,
  BroadcastQueryResponse,
  Credits,
  RateLimit,
  Result,
  Validator,
} from "./types.js";

export interface VerafyClientOptions {
  /** Sent as X-API-Key. Falls back to VERAFY_API_KEY. */
  apiKey?: string;
  /** Defaults to https://api.verafy.ai. Override for staging or a local server. */
  baseUrl?: string;
  /** Attempts per request, including the first. Default 3. */
  attempts?: number;
  /** Per-attempt timeout in ms. Default 120000: a swarm query fans out to many models. */
  timeoutMs?: number;
  /** Longest the client will sit waiting out a 429 before throwing. Default 65000. */
  maxRetryWaitMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_QUERY_CHARS = 1000;
const MAX_VALIDATORS = 20;

/**
 * Marks an error as decided: the retry loop must rethrow it rather than apply
 * its own judgment.
 *
 * Without this, throwing from inside the `try` lands in the same `catch` that
 * decides retryability, and a retryable-but-declined error (a 429 whose reset is
 * further out than maxRetryWaitMs) gets retried anyway. A test caught exactly
 * that: three attempts where there should have been one.
 */
class Decided {
  constructor(readonly error: VerafyError) {}
}

export class VerafyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly maxRetryWaitMs: number;
  private readonly doFetch: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: VerafyClientOptions = {}) {
    const key = opts.apiKey ?? process.env.VERAFY_API_KEY ?? "";
    if (!key) {
      throw new VerafyError(
        "no API key. Pass { apiKey } or set VERAFY_API_KEY. Keys are issued by the Verafy API maintainer.",
      );
    }
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? process.env.VERAFY_BASE_URL ?? "https://api.verafy.ai").replace(/\/+$/, "");
    this.attempts = Math.max(1, opts.attempts ?? 3);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 65_000;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.extraHeaders = opts.headers ?? {};
  }

  /**
   * Credits a broadcast will cost, computed the way the server computes it: one
   * per named validator, or one per `queriesRequested`, or one if neither is
   * given. Call it before `broadcastQuery` to avoid a 403 mid-batch.
   */
  static costOf(req: BroadcastQueryRequest): number {
    return req.selectedLLMIds?.length || req.queriesRequested || 1;
  }

  costOf(req: BroadcastQueryRequest): number {
    return VerafyClient.costOf(req);
  }

  /**
   * Broadcast one query to the swarm and return every validator's vote.
   *
   * Validated client-side first, because the server's 400 costs a round trip and
   * tells the caller less than this does.
   */
  async broadcastQuery(req: BroadcastQueryRequest): Promise<Result<BroadcastQueryResponse>> {
    if (!req.queryText?.trim()) {
      throw new VerafyValidationError("queryText is required and cannot be blank");
    }
    if (req.queryText.length > MAX_QUERY_CHARS) {
      throw new VerafyValidationError(
        `queryText is ${req.queryText.length} characters; the limit is ${MAX_QUERY_CHARS}`,
      );
    }
    if (req.selectedLLMIds && req.selectedLLMIds.length > MAX_VALIDATORS) {
      throw new VerafyValidationError(
        `selectedLLMIds has ${req.selectedLLMIds.length} entries; the limit is ${MAX_VALIDATORS}`,
      );
    }
    const bad = req.selectedLLMIds?.find((id) => !isUuid(id));
    if (bad) {
      throw new VerafyValidationError(
        `selectedLLMIds must be validator UUIDs; "${bad}" is not one. Call validators() to list them.`,
      );
    }
    if (req.queriesRequested !== undefined && (req.queriesRequested < 1 || req.queriesRequested > MAX_VALIDATORS)) {
      throw new VerafyValidationError(`queriesRequested must be between 1 and ${MAX_VALIDATORS}`);
    }

    return this.request<BroadcastQueryResponse>("POST", "/api/v1/public/broadcast-query", { body: req });
  }

  /** Credits left on this key, and when it was last used. */
  async credits(): Promise<Result<Credits>> {
    return this.request<Credits>("GET", "/api/v1/public/credits");
  }

  /** Every validator the swarm knows about. */
  async validators(): Promise<Result<Validator[]>> {
    const r = await this.request<unknown>("GET", "/api/v1/public/validators");
    return { ...r, data: asValidatorArray(r.data) };
  }

  /** Only validators currently able to vote. Use this to build selectedLLMIds. */
  async activeValidators(): Promise<Result<Validator[]>> {
    const r = await this.request<unknown>("GET", "/api/v1/public/validators/active");
    return { ...r, data: asValidatorArray(r.data) };
  }

  async validator(id: string): Promise<Result<Validator>> {
    if (!isUuid(id)) throw new VerafyValidationError(`"${id}" is not a validator UUID`);
    return this.request<Validator>("GET", `/api/v1/public/validators/${id}`);
  }

  /**
   * Broadcast several queries with bounded concurrency, stopping as soon as
   * credits run out rather than burning the remaining calls on 403s.
   *
   * Returns one entry per input in input order, each either a result or the
   * error that query hit, so one bad query does not lose the whole batch.
   */
  async broadcastMany(
    reqs: BroadcastQueryRequest[],
    opts: { concurrency?: number; stopOnCreditsExhausted?: boolean } = {},
  ): Promise<Array<{ request: BroadcastQueryRequest; result?: Result<BroadcastQueryResponse>; error?: VerafyError }>> {
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    const stopOnCredits = opts.stopOnCreditsExhausted ?? true;
    const out: Array<{ request: BroadcastQueryRequest; result?: Result<BroadcastQueryResponse>; error?: VerafyError }> =
      reqs.map((request) => ({ request }));

    let next = 0;
    let halted = false;

    const worker = async () => {
      while (!halted && next < reqs.length) {
        const i = next++;
        try {
          out[i].result = await this.broadcastQuery(reqs[i]);
        } catch (e) {
          const err = e instanceof VerafyError ? e : new VerafyError(String(e));
          out[i].error = err;
          if (stopOnCredits && err.name === "VerafyCreditsError") halted = true;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, reqs.length) }, worker));
    return out;
  }

  // ---------------------------------------------------------------- transport

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<Result<T>> {
    const url = `${this.baseUrl}${path}`;
    let lastError: VerafyError | undefined;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);

      try {
        const res = await this.doFetch(url, {
          method,
          signal: ctl.signal,
          headers: {
            "X-API-Key": this.apiKey,
            Accept: "application/json",
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
            ...this.extraHeaders,
          },
          ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        });

        const rateLimit = readRateLimit(res.headers);
        const text = await res.text();
        const parsed = parseJson(text);

        if (res.ok) {
          if (parsed === undefined) {
            // A 200 that is not JSON means the swarm returned an HTML error page
            // through the proxy. Retrying can succeed.
            const err = new VerafyUpstreamError(
              `expected JSON but got ${looksLikeHtml(text) ? "HTML" : "an unparseable body"} with status ${res.status}`,
              { status: res.status, body: text.slice(0, 500) },
            );
            lastError = err;
            if (attempt < this.attempts) {
              await sleep(backoff(attempt));
              continue;
            }
            throw new Decided(err);
          }
          return { data: parsed as T, rateLimit, status: res.status, attempts: attempt };
        }

        const err = errorFor(res.status, parsed, res.headers);
        lastError = err;

        if (!RETRYABLE_STATUS.has(res.status) || attempt >= this.attempts) throw new Decided(err);

        // A 429 says exactly when to come back. Honor it, within the cap. Past
        // the cap there is nothing useful to do but hand the caller the reset
        // time, so they can decide whether to wait.
        if (err instanceof VerafyRateLimitError) {
          if (err.retryAfterMs > this.maxRetryWaitMs) throw new Decided(err);
          await sleep(err.retryAfterMs + 250);
        } else {
          await sleep(backoff(attempt));
        }
      } catch (e) {
        clearTimeout(timer);

        if (e instanceof Decided) throw e.error;

        if (e instanceof VerafyError) {
          if (!e.retryable || attempt >= this.attempts) throw e;
          lastError = e;
          continue;
        }

        const aborted = e instanceof Error && e.name === "AbortError";
        const err = aborted ? new VerafyTimeoutError(this.timeoutMs) : new VerafyError(messageOf(e));
        lastError = err;
        if (attempt >= this.attempts) throw err;
        await sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new VerafyError(`request to ${path} failed after ${this.attempts} attempts`);
  }
}

function readRateLimit(h: Headers): RateLimit | undefined {
  const remaining = Number(h.get("X-RateLimit-Remaining"));
  const resetAt = Number(h.get("X-RateLimit-Reset"));
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return undefined;
  return { remaining, resetAt };
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const looksLikeHtml = (s: string) => /^\s*<(?:!doctype|html)/i.test(s);

/**
 * The validators endpoints proxy the swarm, which has returned both a bare array
 * and an object wrapping one. Normalize rather than making every caller check.
 */
function asValidatorArray(data: unknown): Validator[] {
  if (Array.isArray(data)) return data as Validator[];
  if (data && typeof data === "object") {
    for (const key of ["validators", "data", "items", "results"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Validator[];
    }
  }
  return [];
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const backoff = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8_000) + Math.random() * 250;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
