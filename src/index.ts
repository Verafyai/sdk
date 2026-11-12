/**
 * @verafy/sdk — the Verafy public API, typed, with retries and real errors.
 *
 *   import { VerafyClient } from "@verafy/sdk";
 *   const verafy = new VerafyClient({ apiKey: process.env.VERAFY_API_KEY! });
 *   const { data } = await verafy.broadcastQuery({ queryText: "...", queriesRequested: 5 });
 */
export { VerafyClient, type VerafyClientOptions } from "./client.js";
export {
  VerafyError,
  VerafyAuthError,
  VerafyCreditsError,
  VerafyRateLimitError,
  VerafyValidationError,
  VerafyServerError,
  VerafyUpstreamError,
  VerafyTimeoutError,
  errorFor,
} from "./errors.js";
export type {
  QueryMode, Vote, BroadcastQueryRequest, BroadcastQueryResponse,
  ValidatorVote, ConfidenceData, Validator, Credits, RateLimit, Result,
} from "./types.js";
