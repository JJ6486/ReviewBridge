/**
 * [1/5] Understand the product + plan the searches. One model call, no tools.
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import { respond } from "../openai.js";
import { planPrompt, SYSTEM_CORE } from "../prompts.js";
import type { ProductInput } from "../products.js";
import { ResearchPlan } from "../schema.js";

export async function planResearch(product: ProductInput): Promise<ResearchPlan> {
  const { data: plan } = await respond({
    label: "plan",
    instructions: SYSTEM_CORE,
    input: planPrompt(product, config.searchQueryCount),
    schema: ResearchPlan,
    schemaName: "research_plan",
    maxOutputTokens: 4_000,
  });

  // Deterministic query hygiene — dedupe, ensure review terminology, cap count.
  plan.search_queries = normaliseQueries(
    plan.search_queries,
    plan.canonical_name ?? product.name,
    config.searchQueryCount,
  );

  if (plan.identified) {
    log.ui(
      `identified: ${plan.identified_brand ?? "?"} / ${plan.identified_model ?? "?"} — ${plan.canonical_name ?? "?"}`,
    );
  } else {
    log.warn("product could not be confidently identified from model knowledge");
  }
  if (plan.likely_confusions.length) {
    log.detail(`must not confuse with: ${plan.likely_confusions.join(", ")}`);
  }
  log.detail(`planned ${plan.search_queries.length} search queries:`);
  for (const q of plan.search_queries) log.detail(`  - ${q}`);

  return plan;
}

function normaliseQueries(raw: string[], name: string, target: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw.map((s) => s.trim()).filter(Boolean)) {
    const key = q.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }

  // Guarantee at least 3 review-focused queries even if the model was stingy.
  const fallbacks = [`"${name}" review`, `"${name}" reviews`, `${name} customer reviews`];
  for (const f of fallbacks) {
    if (out.length >= Math.max(3, Math.min(target, 3))) break;
    const key = f.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }

  return out.slice(0, target);
}
