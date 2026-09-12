/**
 * Token / cost accounting.
 *
 * Every OpenAI Responses API call routes its `response.usage` through `record()`.
 * Nothing here is guessed: token counts come straight from the API. Cost is an
 * ESTIMATE derived from `src/pricing.ts`.
 */
import type { ResponseUsage } from "openai/resources/responses/responses";
import { MODEL_PRICING, pricingFor, WEB_SEARCH_USD_PER_1K_CALLS } from "./pricing.js";
import type { UsageSummary } from "./schema.js";

class UsageTracker {
  apiRequests = 0;
  webSearchCalls = 0;
  inputTokens = 0;
  cachedInputTokens = 0;
  outputTokens = 0; // OpenAI: output_tokens already includes reasoning_tokens
  reasoningTokens = 0;

  reset(): void {
    this.apiRequests = 0;
    this.webSearchCalls = 0;
    this.inputTokens = 0;
    this.cachedInputTokens = 0;
    this.outputTokens = 0;
    this.reasoningTokens = 0;
  }

  /** Record one API response. `webSearchCalls` = # of web_search_call items in it. */
  record(usage: ResponseUsage | null | undefined, webSearchCalls: number): void {
    this.apiRequests += 1;
    this.webSearchCalls += webSearchCalls;
    if (!usage) return;
    this.inputTokens += usage.input_tokens ?? 0;
    this.cachedInputTokens += usage.input_tokens_details?.cached_tokens ?? 0;
    this.outputTokens += usage.output_tokens ?? 0;
    this.reasoningTokens += usage.output_tokens_details?.reasoning_tokens ?? 0;
  }

  summary(model: string): UsageSummary {
    const p = pricingFor(model);
    const totalTokens = this.inputTokens + this.outputTokens;

    let breakdown = { input: 0, cached_input: 0, output: 0, web_search: 0 };
    let estimated: number | null = null;
    let notes: string;

    const webSearchUsd = (this.webSearchCalls / 1000) * WEB_SEARCH_USD_PER_1K_CALLS;

    if (p) {
      const billableInput = Math.max(0, this.inputTokens - this.cachedInputTokens);
      breakdown = {
        input: round6((billableInput / 1e6) * p.input_per_1m),
        cached_input: round6((this.cachedInputTokens / 1e6) * p.cached_input_per_1m),
        output: round6((this.outputTokens / 1e6) * p.output_per_1m),
        web_search: round6(webSearchUsd),
      };
      estimated = round6(
        breakdown.input + breakdown.cached_input + breakdown.output + breakdown.web_search,
      );
      notes =
        `Estimate, not a bill. Token counts are exact (from the API). Per-token rates are ` +
        `OpenAI's standard (short-context) pricing for "${model}"; a request whose input exceeds ` +
        "the model's short-context threshold is billed at a higher tier that cannot be derived " +
        "from usage. Web search is billed at $10.00 / 1,000 calls; web_search_calls here counts one " +
        "unit per query / open_page / find_in_page action (conservative — OpenAI may bill per " +
        "web_search_call item instead, which would be lower).";
    } else {
      breakdown.web_search = round6(webSearchUsd);
      notes =
        `No pricing entry for "${model}" in src/pricing.ts — only the web-search cost ` +
        `($${breakdown.web_search.toFixed(4)}) is known. Add the model to MODEL_PRICING for a full estimate. ` +
        `Known priced models: ${Object.keys(MODEL_PRICING).join(", ")}.`;
    }

    return {
      api_requests: this.apiRequests,
      web_search_calls: this.webSearchCalls,
      input_tokens: this.inputTokens,
      cached_input_tokens: this.cachedInputTokens,
      output_tokens: this.outputTokens,
      reasoning_tokens: this.reasoningTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: estimated,
      cost_breakdown_usd: breakdown,
      pricing_model: model,
      pricing_known: p != null,
      notes,
    };
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export const usage = new UsageTracker();
