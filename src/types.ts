/**
 * Types mirroring the Verafy public API.
 *
 * Fields the API may omit are optional here rather than asserted. The swarm is
 * proxied through the API, and a field present on one deployment can be absent
 * on another; an SDK that types them as required turns that into a runtime crash
 * inside the caller's code instead of a branch they can handle.
 */

export type QueryMode = "fact-check" | "predict" | "create" | "shop";

export type Vote = "YES" | "NO" | "ERROR";

export interface BroadcastQueryRequest {
  /** 1 to 1000 characters. */
  queryText: string;
  queryMode?: QueryMode;
  /** How many models to ask when specific ones are not named. 1 to 20. */
  queriesRequested?: number;
  /** Specific validators to ask, by UUID. Up to 20. One credit each. */
  selectedLLMIds?: string[];
}

export interface ValidatorVote {
  id?: string;
  provider?: string;
  profileName?: string;
  modelName?: string;
  vote?: Vote;
  rationale?: string;
  /** Milliseconds the validator took. */
  latency?: number;
  /** Whether this validator's vote matched the consensus. */
  matchedConsensus?: boolean;
  confidence?: number;
  createdAt?: string;
}

/**
 * Historical agreement data joined onto the live response.
 *
 * It can arrive in three shapes: populated, a `message` saying there is no
 * history for this query, or an `error` when the join failed. The API returns
 * 200 in all three cases, on the view that a live answer is still worth
 * returning when the history lookup fails, so check `totalResponses` before
 * reading `validatorResponses`.
 */
export interface ConfidenceData {
  voteSessionId?: string;
  consensusReached?: boolean;
  consensusValue?: string | boolean | null;
  totalResponses: number;
  validatorResponses: ValidatorVote[];
  sessionTimestamp?: string;
  votesYes?: number;
  votesNo?: number;
  notVoted?: number;
  /** Present when there was no history for this query. */
  message?: string;
  /** Present when the history join itself failed. */
  error?: string;
}

export interface BroadcastQueryResponse {
  id?: string;
  queryText?: string;
  queryMode?: QueryMode;
  responses?: ValidatorVote[];
  consensus?: string | boolean | null;
  confidenceData?: ConfidenceData;
  /** Anything the swarm returned that is not modelled above. */
  [key: string]: unknown;
}

export interface Validator {
  id: string;
  profileName: string;
  provider: string;
  modelName: string;
  publicKey?: string;
  isLeader?: boolean;
  active?: boolean;
  description?: string | null;
  avatarUrl?: string | null;
  validatorType?: string | null;
  /** 0 to 1, correctVotes over totalVotes. Null until it has voted. */
  reliability?: number | null;
  totalVotes?: number;
  correctVotes?: number;
  name?: string | null;
  canonicalSlug?: string | null;
  supportedParameters?: string[];
  popular?: boolean;
  lastVote?: boolean | null;
  lastRationale?: string | null;
  lastResponse?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Credits {
  apiKeyId: string;
  /** One credit per model queried. A new key is initialized with 500. */
  credits: number;
  lastUsed?: string | null;
  [key: string]: unknown;
}

/** Read off X-RateLimit-* on every response, so a caller can pace itself. */
export interface RateLimit {
  /** Requests left in the current hour. */
  remaining: number;
  /** Unix seconds when the window resets. */
  resetAt: number;
}

/** Every call returns the parsed body plus the transport facts about it. */
export interface Result<T> {
  data: T;
  rateLimit?: RateLimit;
  status: number;
  /** Attempts made, including the successful one. 1 means no retry was needed. */
  attempts: number;
}
