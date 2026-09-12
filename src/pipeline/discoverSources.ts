/**
 * [2/5] Discover candidates via OpenAI native web search + [3/5] select.
 *
 * One model call (web search enabled) returns classified candidates; selection
 * of the final <= MAX_SOURCES set is deterministic here.
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import { respond } from "../openai.js";
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
}

export async function discoverSources(
  product: ProductInput,
  plan: ResearchPlan,
): Promise<DiscoveryOutcome> {
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
    maxOutputTokens: 6_000,
  });

  const queriesRun = searchQueries.length ? searchQueries : discovery.queries_run;

  // Dedupe candidates by normalised URL.
  const seen = new Set<string>();
  const candidates = discovery.candidates
    .map((c) => ({
      ...c,
      url: /^https?:\/\//i.test(c.url) ? c.url : `https://${c.url.replace(/^\/+/, "")}`,
      match_confidence: clamp01(c.match_confidence),
    }))
    .filter((c) => {
      const key = normUrl(c.url);
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

  // Deterministic selection: real review pages that are a confident match,
  // best confidence first, capped at MAX_SOURCES. Quality over quota.
  const eligible = candidates.filter(
    (c) => c.select && c.contains_reviews && SELECTABLE.has(c.match_status),
  );
  eligible.sort((a, b) => b.match_confidence - a.match_confidence);
  const selected = eligible.slice(0, config.maxSources);

  log.detail(`selected ${selected.length}/${config.maxSources} source(s) for analysis:`);
  for (const s of selected) log.detail(`  + ${s.source_name} (${s.match_status} ${s.match_confidence.toFixed(2)}) ${s.url}`);

  const rejected = candidates.filter((c) => !selected.includes(c));
  for (const r of rejected) {
    const why = !SELECTABLE.has(r.match_status)
      ? `${r.match_status} — ${r.match_reasoning}`
      : !r.contains_reviews
        ? "no actual review content"
        : !r.select
          ? r.select_reason || "not selected by model"
          : "beyond MAX_SOURCES limit";
    log.detail(`  - rejected: ${r.source_name} (${why})`);
  }

  if (discovery.notes) log.detail(`notes: ${discovery.notes}`);

  return { discovery, selected, webSearchCalls, queriesRun };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function normUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[#?].*$/, "")
    .replace(/\/$/, "");
}
