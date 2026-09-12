/**
 * Pricing — the ONE place API prices live.
 *
 * Rates are OpenAI's published *standard* (short-context) prices, USD per 1M
 * tokens. If OpenAI changes prices, or you use a model not listed here, edit
 * this file. Long-context requests are billed at a higher tier that cannot be
 * derived from the returned usage alone — see `pricing_known` / notes in the
 * cost summary.
 */
export interface ModelPricing {
  input_per_1m: number;
  cached_input_per_1m: number;
  output_per_1m: number;
}

/** OpenAI Responses API web search: flat $10.00 per 1,000 tool calls. */
export const WEB_SEARCH_USD_PER_1K_CALLS = 10.0;

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.6-luna": { input_per_1m: 0.2, cached_input_per_1m: 0.02, output_per_1m: 1.2 },
  "gpt-6-astra": { input_per_1m: 10.0, cached_input_per_1m: 1.0, output_per_1m: 50.0 },
  "gpt-5.5": { input_per_1m: 5.0, cached_input_per_1m: 0.5, output_per_1m: 30.0 },
  "gpt-5.1": { input_per_1m: 1.25, cached_input_per_1m: 0.125, output_per_1m: 10.0 },
  "gpt-5-mini": { input_per_1m: 0.25, cached_input_per_1m: 0.025, output_per_1m: 2.0 },
  "gpt-4.1": { input_per_1m: 2.0, cached_input_per_1m: 0.5, output_per_1m: 8.0 },
  "gpt-4.1-mini": { input_per_1m: 0.4, cached_input_per_1m: 0.1, output_per_1m: 1.6 },
  "gpt-4o-mini": { input_per_1m: 0.15, cached_input_per_1m: 0.075, output_per_1m: 0.6 },
};

/** Exact match, else longest known prefix (handles dated snapshots). */
export function pricingFor(model: string): ModelPricing | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]!;
  const prefix = Object.keys(MODEL_PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? MODEL_PRICING[prefix]! : null;
}
