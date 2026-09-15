/**
 * [5/5] Synthesise sentiment / summary / pros / cons from VALID sources only.
 * One model call, no tools. Skipped entirely when there are no valid sources.
 */
import { log } from "../logger.js";
import { respond } from "../openai.js";
import { synthesizePrompt, SYSTEM_CORE } from "../prompts.js";
import type { ProductInput } from "../products.js";
import { AnalysisResult, type CollectedSource } from "../schema.js";

export async function synthesize(
  product: ProductInput,
  validSources: CollectedSource[],
): Promise<AnalysisResult> {
  if (validSources.length === 0) {
    log.ui("no valid sources — skipping synthesis (no model call)");
    return {
      sentiment: "INSUFFICIENT_DATA",
      summary:
        "No source matched the requested product with enough confidence to analyse. " +
        "No review conclusions can be drawn.",
      pros: [],
      cons: [],
      has_enough_data_for_overall_rating: false,
    };
  }

  const slim = validSources.map((s) => ({
    source_name: s.source_name,
    source_url: s.source_url,
    match_status: s.match_status,
    rating: s.rating,
    rating_scale: s.rating_scale,
    review_count: s.review_count,
    review_summary: s.review_summary,
    positive_points: s.positive_points,
    negative_points: s.negative_points,
    review_excerpts: s.review_excerpts,
  }));

  const { data } = await respond({
    label: "synthesize",
    instructions: SYSTEM_CORE,
    input: synthesizePrompt(product, JSON.stringify(slim, null, 2)),
    schema: AnalysisResult,
    schemaName: "analysis_result",
    maxOutputTokens: 4_000,
  });

  log.ui(`sentiment: ${data.sentiment}`);
  log.ui(`pros: ${data.pros.join(" | ") || "(none)"}`);
  log.ui(`cons: ${data.cons.join(" | ") || "(none)"}`);
  return data;
}
