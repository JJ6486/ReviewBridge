/**
 * Pipeline orchestration + final report assembly.
 *
 * Up to four OpenAI calls per product (fewer once the review-source registry
 * has learned enough about it):
 *   [1/5] plan       (no tools)
 *   [2/5] registry   (deterministic — reuse known sources, no tools)
 *   [3/5] discover   (web search — only if the registry wasn't enough)
 *   [4/5] extract    (web search / open_page — registry refresh and/or new sources)
 *   [5/5] synthesise (no tools) + validate (deterministic)
 */
import { config } from "./config.js";
import { log } from "./logger.js";
import type { ProductInput } from "./products.js";
import { WEB_SEARCH_USD_PER_1K_CALLS } from "./pricing.js";
import { usage } from "./usage.js";
import {
  candidateFromEntry,
  collectedSourceFromEntry,
  computeProductKey,
  dedupeKey,
  registry,
  statusFromExtraction,
  type ProductIdentity,
  type RegistryEntry,
} from "./registry.js";
import {
  ResearchStatus,
  type CollectedSource,
  type DiscoveryResult,
  type Failure,
  type FinalReport,
  type FinalSource,
  type Sentiment,
  type SourceType,
} from "./schema.js";
import { planResearch } from "./pipeline/planResearch.js";
import { discoverSources } from "./pipeline/discoverSources.js";
import { extractReviews } from "./pipeline/extractReviews.js";
import { synthesize } from "./pipeline/synthesize.js";
import { isUsableMatch, validateOutput } from "./pipeline/validateOutput.js";

const TOTAL_STEPS = 5;
const SEARCH_STRATEGY = "OpenAI native web search (Responses API web_search tool)";
const SEARCH_UNIT_COST = WEB_SEARCH_USD_PER_1K_CALLS / 1000; // $ per single web-search action

export async function runResearch(product: ProductInput): Promise<FinalReport> {
  const started = Date.now();
  usage.reset();
  const warnings: string[] = [];

  await registry.load();

  // ---- [1/5] plan -----------------------------------------------------
  log.step(1, TOTAL_STEPS, "Understanding product & planning searches");
  const plan = await planResearch(product);
  if (!plan.identified) {
    warnings.push("Product could not be confidently identified before searching.");
  }

  const identity: ProductIdentity = {
    brand: plan.identified_brand,
    canonical_name: plan.canonical_name,
    requested_name: product.name,
    sku: product.sku,
  };
  const productKey = computeProductKey(identity);

  // ---- [2/5] registry check --------------------------------------------
  log.step(2, TOTAL_STEPS, "Checking review-source registry");
  log.detail(`product key: ${productKey}`);

  const trustedAll = config.registryEnabled ? registry.getTrusted(identity) : [];
  const knownBad = config.registryEnabled ? registry.getKnownBad(identity) : [];
  if (!config.registryEnabled) {
    log.ui("registry disabled (REGISTRY_ENABLED=false) — running full web discovery");
  } else {
    log.ui(`${trustedAll.length} known trusted source(s), ${knownBad.length} known-bad source(s) on file`);
  }

  const sourceTypeByUrl = new Map<string, SourceType>();
  for (const e of trustedAll) sourceTypeByUrl.set(dedupeKey(e.url) ?? e.url, e.source_type);
  for (const e of knownBad) sourceTypeByUrl.set(dedupeKey(e.url) ?? e.url, e.source_type);

  const freshTrusted = trustedAll.filter((e) => registry.isFresh(e));
  const staleTrusted = trustedAll.filter((e) => !registry.isFresh(e));

  const cachedSlice = freshTrusted.slice(0, config.maxSources);
  const cachedSources: CollectedSource[] = cachedSlice.map(collectedSourceFromEntry);
  for (const e of cachedSlice) registry.markReused(e.url, identity);
  if (cachedSlice.length) {
    log.ui(`reusing ${cachedSlice.length} fresh trusted source(s) from cache (no re-check needed):`);
    for (const e of cachedSlice) {
      log.detail(
        `  ~ ${e.source_name} (checked ${e.last_checked.slice(0, 10)}, ${e.times_reused + 1}x reused) ${e.url}`,
      );
    }
  }

  const collected: CollectedSource[] = [...cachedSources];
  const failures: Failure[] = [];
  let refreshedCollected: CollectedSource[] = [];
  let newlyDiscoveredCollected: CollectedSource[] = [];
  let discovery: DiscoveryResult = { queries_run: [], candidates: [], notes: "" };
  let queriesRun: string[] = [];
  let discoverySelectedCount = 0;
  let skippedKnownBad = 0;
  let webDiscoverySkipped = false;
  let toRefresh: RegistryEntry[] = [];

  const usableSoFar = () => collected.filter(isUsableMatch);

  // ---- [3/5] select: is the cache sufficient, or do we need to refresh / discover? ----
  log.step(3, TOTAL_STEPS, "Selecting sources");
  if (usableSoFar().length >= config.registryMinSources) {
    webDiscoverySkipped = true;
    log.ui(
      `cached trusted sources already sufficient (${usableSoFar().length}/${config.registryMinSources} needed) — skipping web discovery`,
    );
  } else {
    const refreshBudget = Math.max(0, config.maxSources - collected.length);
    toRefresh = staleTrusted.slice(0, refreshBudget);
    if (toRefresh.length) {
      log.ui(
        `will re-verify ${toRefresh.length} known trusted source(s) past the ${config.registryTtlHours}h freshness window before falling back to web discovery`,
      );
    } else {
      log.ui("no usable known sources on file — falling back to web discovery");
    }
  }

  // ---- [4/5] extract: refresh known sources, then discover+extract if still short ----
  log.step(4, TOTAL_STEPS, "Extracting review data from selected sources");
  if (webDiscoverySkipped) {
    log.ui(`skipped — ${cachedSources.length} source(s) served entirely from the registry cache`);
  } else {
    if (toRefresh.length) {
      const refreshCandidates = toRefresh.map(candidateFromEntry);
      for (const c of refreshCandidates) {
        sourceTypeByUrl.set(dedupeKey(c.url) ?? c.url, c.source_type);
      }
      const refreshOutcome = await extractReviews(product, plan, refreshCandidates);
      refreshedCollected = refreshOutcome.collected;
      failures.push(...refreshOutcome.failures);
      collected.push(...refreshedCollected);
    }

    if (usableSoFar().length >= config.registryMinSources) {
      webDiscoverySkipped = true;
      log.ui(`known sources sufficient after refresh (${usableSoFar().length} usable) — skipping web discovery`);
    } else {
      const excludeUrls = new Set(knownBad.map((e) => dedupeKey(e.url) ?? e.url));
      const remaining = Math.max(0, config.maxSources - collected.length);
      if (remaining > 0) {
        log.ui("known sources still insufficient — running web discovery for the remainder");
        const discOutcome = await discoverSources(product, plan, { excludeUrls, limit: remaining });
        discovery = discOutcome.discovery;
        queriesRun = discOutcome.queriesRun;
        skippedKnownBad = discOutcome.skippedKnownBad;
        discoverySelectedCount = discOutcome.selected.length;
        if (discovery.notes) warnings.push(`discovery notes: ${discovery.notes}`);
        for (const c of discOutcome.selected) {
          sourceTypeByUrl.set(dedupeKey(c.url) ?? c.url, c.source_type);
        }

        const newOutcome = await extractReviews(product, plan, discOutcome.selected);
        newlyDiscoveredCollected = newOutcome.collected;
        failures.push(...newOutcome.failures);
        collected.push(...newlyDiscoveredCollected);
      }
    }
  }

  const finalSources: FinalSource[] = collected.map((s) => ({
    ...s,
    included_in_analysis: isUsableMatch(s) && s.extraction_status !== "FAILED",
  }));
  const validSources = finalSources.filter((s) => s.included_in_analysis);
  log.ui(
    `${validSources.length} of ${finalSources.length} analysed source(s) are a usable exact/likely match`,
  );

  // ---- registry write-back: only for sources actually (re-)verified this run ----
  let newSourcesRecorded = 0;
  if (config.registryEnabled) {
    const verifiedThisRun = [...refreshedCollected, ...newlyDiscoveredCollected];
    for (const s of verifiedThisRun) {
      const key = dedupeKey(s.source_url) ?? s.source_url;
      const sourceType = sourceTypeByUrl.get(key) ?? "OTHER";
      const status = statusFromExtraction(s);
      registry.upsert({
        url: s.source_url,
        product_key: productKey,
        product_identity: identity,
        source_name: s.source_name,
        source_type: sourceType,
        status,
        match_status: s.match_status,
        match_confidence: s.match_confidence,
        match_reasoning: s.match_reasoning,
        rating: s.rating,
        rating_scale: s.rating_scale,
        review_count: s.review_count,
        rating_is_product_rating: s.rating_is_product_rating,
        seller_rating: s.seller_rating,
        brand_rating: s.brand_rating,
        review_summary: s.review_summary,
        positive_points: s.positive_points,
        negative_points: s.negative_points,
        extraction_status: s.extraction_status,
        notes: s.notes,
      });
      newSourcesRecorded++;
      log.detail(`  registry <- ${status} ${s.source_name} ${s.source_url}`);
    }
    await registry.save();
  }

  const costSaved = webDiscoverySkipped ? plan.search_queries.length * SEARCH_UNIT_COST : 0;
  const costUtilized = cachedSlice.length * SEARCH_UNIT_COST;
  log.ui(
    `registry summary: ${cachedSlice.length} reused from cache, ${refreshedCollected.length} refreshed, ` +
      `${skippedKnownBad} known-bad skipped, ${newlyDiscoveredCollected.length} newly discovered & recorded` +
      (costSaved > 0 ? `, ~$${costSaved.toFixed(4)} web-search cost saved (discovery skipped)` : "") +
      (costUtilized > 0 ? `, ~$${costUtilized.toFixed(4)} equivalent web-search cost utilized from cache` : ""),
  );

  // ---- [5/5] synthesise + validate ------------------------------------
  log.step(5, TOTAL_STEPS, "Synthesising & validating");
  const analysis = await synthesize(product, validSources);

  const runSeconds = Math.round((Date.now() - started) / 100) / 10;
  const hasData = validSources.length > 0;
  const sentiment: Sentiment | null = hasData ? analysis.sentiment : null;
  const totalSelected = cachedSlice.length + toRefresh.length + discoverySelectedCount;

  const draft: FinalReport = {
    product: {
      requested_name: product.name,
      sku: product.sku,
      model: product.model,
      identified_brand: plan.identified_brand,
      identified_model: plan.identified_model,
      canonical_name: plan.canonical_name,
    },
    research_status: deriveStatus(plan.identified, totalSelected, validSources.length),
    overall: {
      sentiment,
      summary: hasData ? analysis.summary : null,
      total_valid_sources: validSources.length,
      combined_rating: null,
      combined_rating_note:
        "This PoC does not compute a combined rating; per-source ratings are the reliable signal.",
      // Placeholder — validateOutput() recomputes this for real from the
      // guardrailed source list, same as total_valid_sources above.
      average_rating: {
        value: null,
        scale: 5,
        review_count: 0,
        sources_with_rating: 0,
        method: "INSUFFICIENT_DATA",
        note: "",
      },
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
      sources_selected: totalSelected,
      sources_analyzed: finalSources.length,
      registry: {
        enabled: config.registryEnabled,
        product_key: productKey,
        known_trusted: trustedAll.length,
        known_bad: knownBad.length,
        reused_from_cache: cachedSlice.length,
        refreshed: refreshedCollected.length,
        skipped_known_bad: skippedKnownBad,
        new_sources_recorded: newSourcesRecorded,
        web_discovery_skipped: webDiscoverySkipped,
        estimated_cost_saved_usd: round4(costSaved),
        estimated_cost_utilized_usd: round4(costUtilized),
      },
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

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
