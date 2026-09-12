/**
 * Pipeline orchestration + final report assembly.
 *
 * Four OpenAI calls total:
 *   [1/5] plan       (no tools)
 *   [2/5] discover   (web search)
 *   [3/5] select     (deterministic)
 *   [4/5] extract    (web search / open_page)
 *   [5/5] synthesise (no tools) + validate (deterministic)
 */
import { config } from "./config.js";
import { log } from "./logger.js";
import type { ProductInput } from "./products.js";
import { usage } from "./usage.js";
import {
  ResearchStatus,
  type FinalReport,
  type FinalSource,
  type Sentiment,
} from "./schema.js";
import { planResearch } from "./pipeline/planResearch.js";
import { discoverSources } from "./pipeline/discoverSources.js";
import { extractReviews } from "./pipeline/extractReviews.js";
import { synthesize } from "./pipeline/synthesize.js";
import { isUsableMatch, validateOutput } from "./pipeline/validateOutput.js";

const TOTAL_STEPS = 5;
const SEARCH_STRATEGY = "OpenAI native web search (Responses API web_search tool)";

export async function runResearch(product: ProductInput): Promise<FinalReport> {
  const started = Date.now();
  usage.reset();
  const warnings: string[] = [];

  // ---- [1/5] plan ----------------------------------------------------
  log.step(1, TOTAL_STEPS, "Understanding product & planning searches");
  const plan = await planResearch(product);
  if (!plan.identified) {
    warnings.push("Product could not be confidently identified before searching.");
  }

  // ---- [2/5] discover ---------------------------------------------------
  log.step(2, TOTAL_STEPS, "Running web searches & discovering candidates");
  const { discovery, selected, queriesRun } = await discoverSources(product, plan);
  if (discovery.notes) warnings.push(`discovery notes: ${discovery.notes}`);

  // ---- [3/5] select ---------------------------------------------------
  log.step(3, TOTAL_STEPS, "Selecting sources");
  log.detail(
    `${discovery.candidates.length} candidate(s) -> ${selected.length} selected (max ${config.maxSources})`,
  );

  // ---- [4/5] extract ------------------------------------------------
  log.step(4, TOTAL_STEPS, "Extracting review data from selected sources");
  const { collected, failures } = await extractReviews(product, plan, selected);

  const finalSources: FinalSource[] = collected.map((s) => ({
    ...s,
    included_in_analysis: isUsableMatch(s) && s.extraction_status !== "FAILED",
  }));
  const validSources = finalSources.filter((s) => s.included_in_analysis);
  log.detail(
    `${validSources.length} of ${finalSources.length} analysed source(s) are a usable exact/likely match`,
  );

  // ---- [5/5] synthesise + validate --------------------------------
  log.step(5, TOTAL_STEPS, "Synthesising & validating");
  const analysis = await synthesize(product, validSources);

  const runSeconds = Math.round((Date.now() - started) / 100) / 10;
  const hasData = validSources.length > 0;
  const sentiment: Sentiment | null = hasData ? analysis.sentiment : null;

  const draft: FinalReport = {
    product: {
      requested_name: product.name,
      sku: product.sku,
      model: product.model,
      identified_brand: plan.identified_brand,
      identified_model: plan.identified_model,
      canonical_name: plan.canonical_name,
    },
    research_status: deriveStatus(plan.identified, selected.length, validSources.length),
    overall: {
      sentiment,
      summary: hasData ? analysis.summary : null,
      total_valid_sources: validSources.length,
      combined_rating: null,
      combined_rating_note:
        "This PoC does not compute a combined rating; per-source ratings are the reliable signal.",
    },
    pros: hasData ? analysis.pros : [],
    cons: hasData ? analysis.cons : [],
    sources: finalSources,
    failures,
    warnings,
    usage: usage.summary(config.openaiModel),
    meta: {
      provider: "openai",
      model: config.openaiModel,
      search_strategy: SEARCH_STRATEGY,
      generated_at: new Date().toISOString(),
      run_seconds: runSeconds,
      search_queries: queriesRun,
      candidates_discovered: discovery.candidates.length,
      sources_selected: selected.length,
      sources_analyzed: finalSources.length,
    },
  };

  return validateOutput(draft);
}

function deriveStatus(
  identified: boolean,
  selectedCount: number,
  validCount: number,
): ResearchStatus {
  if (validCount > 0) return "SUCCESS";
  if (!identified) return "PRODUCT_NOT_IDENTIFIED";
  if (selectedCount === 0) return "NO_RELIABLE_SOURCES";
  return "PARTIAL";
}
