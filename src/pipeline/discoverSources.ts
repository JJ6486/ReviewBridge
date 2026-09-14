/**
 * [2/5] Discover candidates via OpenAI native web search + [3/5] select.
 *
 * One model call (web search enabled) returns classified candidates; selection
 * of the final <= MAX_SOURCES set is deterministic here. Callers (the registry
 * fallback path) may pass already-known-bad URLs to exclude and a smaller
 * `limit` when some of the source budget is already filled from the registry.
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import { respond } from "../openai.js";
import { dedupeKey, normalizeUrl } from "../registry.js";
import { discoverPrompt, SYSTEM_CORE } from "../prompts.js";
import type { ProductInput } from "../products.js";
import {
  DiscoveryResult,
  type DiscoveredCandidate,
  type ResearchPlan,
} from "../schema.js";

const SELECTABLE = new Set(["EXACT_MATCH", "LIKELY_MATCH"]);

export interface DiscoveryOutcome {
  discovery: DiscoveryResult;
  selected: DiscoveredCandidate[];
  webSearchCalls: number;
  queriesRun: string[];
  skippedKnownBad: number;
}

export interface DiscoverOptions {
  /** Normalised URLs already known not to work for this product — never selected. */
  excludeUrls?: Set<string>;
  /** Cap on how many sources to select (defaults to config.maxSources). */
  limit?: number;
}

export async function discoverSources(
  product: ProductInput,
  plan: ResearchPlan,
  opts: DiscoverOptions = {},
): Promise<DiscoveryOutcome> {
  const limit = opts.limit ?? config.maxSources;
  const excludeUrls = opts.excludeUrls ?? new Set<string>();

  const { data: discovery, webSearchCalls, searchQueries } = await respond({
    label: "discover",
    instructions: SYSTEM_CORE,
    input: discoverPrompt(product, plan),
    schema: DiscoveryResult,
    schemaName: "discovery_result",
    webSearch: true,
    searchContextSize: "low",
    // one search per planned query, plus a little slack
    maxToolCalls: plan.search_queries.length + 2,
    // Enough room for a couple dozen classified candidates — a thin budget here
    // truncates the JSON mid-object and fails the whole discovery call.
    maxOutputTokens: 10_000,
  });

  const queriesRun = searchQueries.length ? searchQueries : discovery.queries_run;

  // Dedupe candidates by normalised URL (tracking params stripped, www/scheme folded).
  const seen = new Set<string>();
  const candidates = discovery.candidates
    .map((c) => ({
      ...c,
      url: normalizeUrl(c.url)?.url ?? c.url,
      match_confidence: clamp01(c.match_confidence),
    }))
    .filter((c) => {
      const key = dedupeKey(c.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  discovery.candidates = candidates;

  log.detail(`discovered ${candidates.length} candidate page(s):`);
  for (const c of candidates) {
    log.detail(
      `  - ${c.source_name} [${c.source_type}] ${c.match_status} ${c.match_confidence.toFixed(2)}` +
        `${c.contains_reviews ? "" : " (no review content)"} ${c.url}`,
    );
  }

  // Deterministic selection: real review pages that are a confident match and
  // not already known-bad for this exact product, best confidence first,
  // capped at `limit`. Quality over quota.
  let skippedKnownBad = 0;
  const eligible = candidates.filter((c) => {
    if (!(c.select && c.contains_reviews && SELECTABLE.has(c.match_status))) return false;
    const key = dedupeKey(c.url) ?? c.url;
    if (excludeUrls.has(key)) {
      skippedKnownBad++;
      log.detail(`  - skipping known-bad source: ${c.source_name} ${c.url}`);
      return false;
    }
    return true;
  });
  eligible.sort((a, b) => b.match_confidence - a.match_confidence);
  const selected = eligible.slice(0, limit);

  log.detail(`selected ${selected.length}/${limit} source(s) for analysis:`);
  for (const s of selected) log.detail(`  + ${s.source_name} (${s.match_status} ${s.match_confidence.toFixed(2)}) ${s.url}`);

  const rejected = candidates.filter((c) => !selected.includes(c));
  for (const r of rejected) {
    const key = dedupeKey(r.url) ?? r.url;
    const why = excludeUrls.has(key)
      ? "known-bad for this product — see registry"
      : !SELECTABLE.has(r.match_status)
        ? `${r.match_status} — ${r.match_reasoning}`
        : !r.contains_reviews
          ? "no actual review content"
          : !r.select
            ? r.select_reason || "not selected by model"
            : "beyond source limit";
    log.detail(`  - rejected: ${r.source_name} (${why})`);
  }

  if (discovery.notes) log.detail(`notes: ${discovery.notes}`);

  return { discovery, selected, webSearchCalls, queriesRun, skippedKnownBad };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
