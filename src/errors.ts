/**
 * Typed errors.
 *
 * The API distinguishes four failures that a caller handles differently, and an
 * SDK that collapses them into one `Error` with a string message forces every
 * caller to parse that string. So each one is its own class with the fields you
 * need to act on it:
 *
 *   VerafyAuthError      the key is wrong or deactivated. Stop. Retrying never helps.
 *   VerafyCreditsError   out of credits. Carries `required` so a caller can top up
 *                        by the right amount rather than guessing.
 *   VerafyRateLimitError carries `resetAt` and `retryAfterMs`, so a caller can wait
 *                        the right length of time instead of backing off blindly.
 *   VerafyServerError    transient. Already retried by the client before you see it.
 *
 * `VerafyError.retryable` lets a caller branch without knowing the subclasses.
 */

export class VerafyError extends Error {
  readonly status?: number;
  readonly requestId?: string;
  /** Whether retrying the identical request could succeed. */
  readonly retryable: boolean = false;
  /** Raw body, when the server sent one that parsed. */
  readonly body?: unknown;

  constructor(message: string, opts: { status?: number; requestId?: string; body?: unknown } = {}) {
    super(message);
    this.name = "VerafyError";
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.body = opts.body;
  }
}

export class VerafyAuthError extends VerafyError {
  override readonly retryable = false;
  constructor(message = "Invalid or inactive API key", opts: { status?: number; body?: unknown } = {}) {
    super(message, { status: opts.status ?? 401, body: opts.body });
    this.name = "VerafyAuthError";
  }
}

export class VerafyCreditsError extends VerafyError {
  override readonly retryable = false;
  /** Credits the request needed, one per model queried. */
  readonly required?: number;
  readonly available?: number;

  constructor(message: string, opts: { required?: number; available?: number; body?: unknown } = {}) {
    super(message, { status: 403, body: opts.body });
    this.name = "VerafyCreditsError";
    this.required = opts.required;
    this.available = opts.available;
  }
}

export class VerafyRateLimitError extends VerafyError {
  override readonly retryable = true;
  /** Unix seconds when the window resets, from X-RateLimit-Reset. */
  readonly resetAt?: number;
  readonly retryAfterMs: number;

  constructor(message: string, opts: { resetAt?: number; retryAfterMs?: number; body?: unknown } = {}) {
    super(message, { status: 429, body: opts.body });
    this.name = "VerafyRateLimitError";
    this.resetAt = opts.resetAt;
    this.retryAfterMs = opts.retryAfterMs ?? (opts.resetAt ? Math.max(0, opts.resetAt * 1000 - Date.now()) : 60_000);
  }
}

export class VerafyValidationError extends VerafyError {
  override readonly retryable = false;
  /** Field-level detail from the server's Zod formatting, when present. */
  readonly details?: unknown;

  constructor(message: string, opts: { details?: unknown; body?: unknown } = {}) {
    super(message, { status: 400, body: opts.body });
    this.name = "VerafyValidationError";
    this.details = opts.details;
  }
}

export class VerafyServerError extends VerafyError {
  override readonly retryable = true;
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message, { status: opts.status ?? 500, body: opts.body });
    this.name = "VerafyServerError";
  }
}

/**
 * The upstream swarm returned something that was not JSON, which in practice
 * means an HTML error page. Separate from VerafyServerError because the fault is
 * downstream of the API and a caller may want to report it differently.
 */
export class VerafyUpstreamError extends VerafyError {
  override readonly retryable = true;
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message, { status: opts.status ?? 502, body: opts.body });
    this.name = "VerafyUpstreamError";
  }
}

export class VerafyTimeoutError extends VerafyError {
  override readonly retryable = true;
  constructor(readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "VerafyTimeoutError";
  }
}

/** Map an HTTP status and parsed body onto the right error class. */
export function errorFor(status: number, body: unknown, headers?: Headers): VerafyError {
  const message = pickMessage(body) ?? `request failed with status ${status}`;

  if (status === 401) return new VerafyAuthError(message, { status, body });

  if (status === 403) {
    return new VerafyCreditsError(message, {
      required: numberIn(body, "required"),
      available: numberIn(body, "credits") ?? numberIn(body, "available"),
      body,
    });
  }

  if (status === 429) {
    const reset = Number(headers?.get("X-RateLimit-Reset"));
    return new VerafyRateLimitError(message, {
      resetAt: Number.isFinite(reset) ? reset : undefined,
      body,
    });
  }

  if (status === 400) {
    return new VerafyValidationError(message, {
      details: (body as { details?: unknown } | null)?.details,
      body,
    });
  }

  if (status === 502) return new VerafyUpstreamError(message, { status, body });
  if (status >= 500) return new VerafyServerError(message, { status, body });

  return new VerafyError(message, { status, body });
}

function pickMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string") return e;
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

function numberIn(body: unknown, key: string): number | undefined {
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>)[key];
    if (Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}
