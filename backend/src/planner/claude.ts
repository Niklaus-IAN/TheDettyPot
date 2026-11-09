import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db/index.js";

export type ClaudeRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ClaudeMessage = Anthropic.Beta.Messages.BetaMessage;
export type ClaudeMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ClaudeTool = Anthropic.Beta.Messages.BetaTool;
export type ClaudeToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** The one call the planner makes, behind an interface so tests can stand in for Claude. */
export interface ClaudeClient {
  createMessage(params: ClaudeRequest): Promise<ClaudeMessage>;
}

export class AnthropicClaudeClient implements ClaudeClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    // The SDK retries rate limits, overloads and dropped connections twice by itself.
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  createMessage(params: ClaudeRequest): Promise<ClaudeMessage> {
    return this.client.beta.messages.create(params);
  }
}

/**
 * Models that can hand a declined request to another model inside the same
 * call. A fallback model's tokens are priced at its own rate (see costOf).
 */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function withFallback(params: ClaudeRequest): ClaudeRequest {
  if (!FALLBACK_MODELS.has(params.model)) return params;
  return { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

/**
 * Dollars per million tokens (Anthropic's list prices, November 2026). Cache
 * writes are 1.25x input (five-minute cache); cache reads as listed.
 * Haiku 5.5's rates are for prompts up to 100K tokens, far above what the
 * planner sends.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

interface TokenCounts {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Cost in billionths of a dollar ($1 per million tokens is 1,000 nano-dollars
 * per token). When a fallback model answered, each model's share is priced at
 * its own rate. Null if any model's price is unknown.
 */
export function costOf(requestedModel: string, message: Pick<ClaudeMessage, "model" | "usage">): number | null {
  const iterations = (message.usage.iterations ?? []).filter((i) => i.type === "message" || i.type === "fallback_message");
  const parts: TokenCounts[] = iterations.length
    ? iterations.map((i) => ({
        model: ("model" in i && i.model) || requestedModel,
        input: i.input_tokens,
        output: i.output_tokens,
        cacheRead: i.cache_read_input_tokens ?? 0,
        cacheWrite: i.cache_creation_input_tokens ?? 0,
      }))
    : [
        {
          model: message.model,
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        },
      ];
  let total = 0;
  for (const p of parts) {
    const price = PRICES[p.model];
    if (!price) return null;
    total += (p.input * price.input + p.output * price.output + p.cacheRead * price.cacheRead + p.cacheWrite * price.cacheWrite) * 1000;
  }
  return Math.round(total);
}

export interface CallContext {
  potId: string;
  userId: string | null;
  messageId: string | null;
  purpose: "plan" | "summary";
  promptVersion: string;
}

/**
 * Calls Claude and logs the call, with its prompt, model, tokens and cost,
 * whether it succeeds or fails (AI-11). Tool definitions are left out of the
 * log: they're fixed by the prompt version.
 */
export async function callClaude(db: Db, claude: ClaudeClient, ctx: CallContext, params: ClaudeRequest): Promise<ClaudeMessage> {
  const started = Date.now();
  const { tools: _tools, ...logged } = params;
  const base = {
    pot_id: ctx.potId,
    user_id: ctx.userId,
    message_id: ctx.messageId,
    purpose: ctx.purpose,
    requested_model: params.model,
    prompt_version: ctx.promptVersion,
    request: JSON.stringify(logged),
  };
  let message: ClaudeMessage;
  try {
    message = await claude.createMessage(params);
  } catch (err) {
    await db
      .insertInto("ai_calls")
      .values({ ...base, duration_ms: Date.now() - started, error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 1000) : "unknown error" })
      .execute();
    throw err;
  }
  const u = message.usage;
  await db
    .insertInto("ai_calls")
    .values({
      ...base,
      model: message.model,
      response: JSON.stringify({ content: message.content, stop_details: message.stop_details ?? null }),
      stop_reason: message.stop_reason,
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      cost_nano_usd: costOf(params.model, message),
      duration_ms: Date.now() - started,
    })
    .execute();
  return message;
}
