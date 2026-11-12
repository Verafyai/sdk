#!/usr/bin/env node
/**
 * MCP server for the Verafy public API.
 *
 * Puts the swarm inside Claude Code, Cursor, Codex and Gemini CLI: an agent can
 * list validators, check credits, and broadcast a question to a panel of models
 * and read back every vote.
 *
 * Credits are the thing to get right here. A broadcast costs one credit per model
 * queried, and an agent that does not know that will drain a key in a handful of
 * calls. So:
 *
 *   - `verafy_cost` prices a broadcast without spending anything.
 *   - `verafy_broadcast` refuses to run without `confirm: true`, and it checks
 *     the remaining balance first, failing with the shortfall rather than
 *     spending down to zero and then erroring.
 *   - every broadcast result reports the credits spent and what is left, so the
 *     agent's own context carries the budget.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { VerafyClient } from "./client.js";
import { VerafyError } from "./errors.js";
import type { Validator } from "./types.js";

const server = new Server({ name: "verafy", version: "0.1.0" }, { capabilities: { tools: {} } });

let cached: VerafyClient | undefined;
function client(): VerafyClient {
  if (!cached) cached = new VerafyClient();
  return cached;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "verafy_validators",
      description:
        "List the validators available to answer a query. Each is a language model wrapped in a harness, with a reliability score from its past votes. Use active: true to get only the ones that can vote right now, and take their ids for verafy_broadcast.",
      inputSchema: {
        type: "object",
        properties: {
          active: { type: "boolean", description: "Only validators currently able to vote. Default true." },
          provider: { type: "string", description: "Filter by provider, e.g. openai, anthropic, google." },
          limit: { type: "number", description: "Cap the list. Default 50." },
        },
      },
    },
    {
      name: "verafy_validator",
      description: "Read one validator by UUID: its model, provider, reliability, vote history and last ruling.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Validator UUID." } },
        required: ["id"],
      },
    },
    {
      name: "verafy_credits",
      description: "Credits left on the configured API key. One credit buys one model's answer to one query.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "verafy_cost",
      description:
        "Price a broadcast before running it. One credit per model queried. Returns the cost, the current balance and whether the key can afford it. Spends nothing.",
      inputSchema: {
        type: "object",
        properties: {
          queriesRequested: { type: "number", description: "How many models to ask, 1 to 20." },
          validatorIds: { type: "array", items: { type: "string" }, description: "Specific validators, up to 20. Takes precedence over queriesRequested." },
        },
      },
    },
    {
      name: "verafy_broadcast",
      description:
        "Send one question to a panel of validators and return every vote with its rationale, plus the consensus and any historical agreement data. THIS SPENDS CREDITS, one per model. Requires confirm: true. Call verafy_cost first.",
      inputSchema: {
        type: "object",
        properties: {
          queryText: { type: "string", description: "The question. Up to 1000 characters." },
          queryMode: {
            type: "string",
            enum: ["fact-check", "predict", "create", "shop"],
            description: "What kind of question it is. fact-check is the default use.",
          },
          queriesRequested: { type: "number", description: "How many models to ask, 1 to 20." },
          validatorIds: { type: "array", items: { type: "string" }, description: "Ask these specific validators." },
          confirm: { type: "boolean", description: "Must be true. Guards against an agent spending credits on its own." },
        },
        required: ["queryText"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (req.params.name) {
      case "verafy_validators": {
        const active = a.active !== false;
        const { data, rateLimit } = active ? await client().activeValidators() : await client().validators();
        let rows = data;
        if (typeof a.provider === "string") {
          const p = a.provider.toLowerCase();
          rows = rows.filter((v) => v.provider?.toLowerCase() === p);
        }
        const limit = num(a.limit, 50);
        return ok({
          count: rows.length,
          shown: Math.min(rows.length, limit),
          rateLimit,
          validators: rows.slice(0, limit).map(brief),
          note: "One credit per validator queried. Pass these ids to verafy_broadcast as validatorIds.",
        });
      }

      case "verafy_validator": {
        const { data } = await client().validator(String(a.id));
        return ok(data);
      }

      case "verafy_credits": {
        const { data, rateLimit } = await client().credits();
        return ok({ credits: data.credits, apiKeyId: data.apiKeyId, lastUsed: data.lastUsed, rateLimit });
      }

      case "verafy_cost": {
        const ids = strings(a.validatorIds);
        const cost = VerafyClient.costOf({
          queryText: "x",
          queriesRequested: a.queriesRequested === undefined ? undefined : num(a.queriesRequested, 1),
          selectedLLMIds: ids.length ? ids : undefined,
        });
        const { data } = await client().credits();
        return ok({
          cost,
          balance: data.credits,
          affordable: data.credits >= cost,
          shortfall: Math.max(0, cost - data.credits),
          note: "Named validators take precedence over queriesRequested, matching the server.",
        });
      }

      case "verafy_broadcast": {
        if (a.confirm !== true) {
          return err(
            "verafy_broadcast spends one credit per model queried. Call verafy_cost to price it, then call again with confirm: true.",
          );
        }

        const ids = strings(a.validatorIds);
        const request = {
          queryText: String(a.queryText ?? ""),
          queryMode: a.queryMode as "fact-check" | "predict" | "create" | "shop" | undefined,
          queriesRequested: a.queriesRequested === undefined ? undefined : num(a.queriesRequested, 1),
          selectedLLMIds: ids.length ? ids : undefined,
        };

        const cost = VerafyClient.costOf(request);
        const before = await client().credits();
        if (before.data.credits < cost) {
          return err(
            `this broadcast costs ${cost} credits and the key has ${before.data.credits}. Short by ${cost - before.data.credits}. Reduce queriesRequested or top up the key.`,
          );
        }

        const { data, rateLimit } = await client().broadcastQuery(request);
        const votes = data.responses ?? data.confidenceData?.validatorResponses ?? [];

        return ok({
          creditsSpent: cost,
          creditsRemaining: before.data.credits - cost,
          rateLimit,
          queryText: request.queryText,
          consensus: data.consensus ?? data.confidenceData?.consensusValue ?? null,
          consensusReached: data.confidenceData?.consensusReached,
          tally: {
            yes: data.confidenceData?.votesYes,
            no: data.confidenceData?.votesNo,
            notVoted: data.confidenceData?.notVoted,
          },
          votes: votes.map((v) => ({
            validator: v.profileName ?? v.modelName ?? v.id,
            provider: v.provider,
            vote: v.vote,
            rationale: v.rationale,
            latencyMs: v.latency,
            matchedConsensus: v.matchedConsensus,
          })),
          historyNote: data.confidenceData?.message ?? data.confidenceData?.error,
        });
      }

      default:
        return err(`unknown tool: ${req.params.name}`);
    }
  } catch (e) {
    if (e instanceof VerafyError) {
      // Hand the agent the fields it can act on rather than a flattened string.
      return err(e.message, {
        kind: e.name,
        status: e.status,
        retryable: e.retryable,
        ...(e.name === "VerafyRateLimitError" ? { resetAt: (e as { resetAt?: number }).resetAt } : {}),
        ...(e.name === "VerafyCreditsError"
          ? { required: (e as { required?: number }).required, available: (e as { available?: number }).available }
          : {}),
      });
    }
    return err(e instanceof Error ? e.message : String(e));
  }
});

const brief = (v: Validator) => ({
  id: v.id,
  name: v.profileName ?? v.name,
  provider: v.provider,
  model: v.modelName,
  active: v.active,
  reliability: v.reliability,
  votes: v.totalVotes,
});

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function ok(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function err(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

await server.connect(new StdioServerTransport());
