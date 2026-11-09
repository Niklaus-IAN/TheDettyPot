import { randomUUID } from "node:crypto";
import type { ClaudeClient, ClaudeMessage, ClaudeRequest } from "../src/planner/claude.js";

type Block = ClaudeMessage["content"][number];
interface Reply {
  content: Block[];
  stop_reason?: ClaudeMessage["stop_reason"];
  model?: string;
  usage?: Partial<ClaudeMessage["usage"]>;
}
type Step = (params: ClaudeRequest) => Reply | Promise<Reply>;

/**
 * Stands in for Claude in tests. Each call takes the next scripted step and
 * records exactly what was sent, so tests can check the prompt.
 */
export class FakeClaude implements ClaudeClient {
  calls: ClaudeRequest[] = [];
  private steps: Step[] = [];

  /** Queue what Claude does on its next calls, in order. */
  will(...steps: (Step | Reply)[]): this {
    this.steps.push(...steps.map((s) => (typeof s === "function" ? s : () => s)));
    return this;
  }

  reset() {
    this.calls = [];
    this.steps = [];
  }

  get pending() {
    return this.steps.length;
  }

  async createMessage(params: ClaudeRequest): Promise<ClaudeMessage> {
    // The planner keeps adding to its messages array; keep what was sent at the time.
    this.calls.push(structuredClone(params));
    const step = this.steps.shift();
    if (!step) throw new Error("FakeClaude: nothing scripted for this call");
    const r = await step(params);
    return {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: r.model ?? params.model,
      content: r.content,
      stop_reason: r.stop_reason ?? (r.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        server_tool_use: null,
        service_tier: "standard",
        iterations: null,
        ...r.usage,
      },
    } as unknown as ClaudeMessage;
  }
}

const toolUse = (name: string, input: object): Block => ({ type: "tool_use", id: `toolu_${randomUUID().slice(0, 12)}`, name, input }) as unknown as Block;

export const text = (t: string): Reply => ({ content: [{ type: "text", text: t, citations: null } as unknown as Block] });
export const search = (...queries: string[]): Reply => ({ content: queries.map((query) => toolUse("search_places", { query })) });

export interface SuggestionInput {
  place_id: string;
  why?: string;
  estimated_cost_per_person_naira?: number | null;
  safety_note?: string | null;
}
export const share = (reply: string, suggestions: SuggestionInput[] = []): Reply => ({
  content: [
    toolUse("share_suggestions", {
      reply,
      suggestions: suggestions.map((s) => ({ why: "Fits the vibe", estimated_cost_per_person_naira: null, safety_note: null, ...s })),
    }),
  ],
});
export const refuse = (): Reply => ({ content: [], stop_reason: "refusal" });
