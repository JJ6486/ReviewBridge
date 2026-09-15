/**
 * [4/5] Extract review data from the selected pages. One model call with web
 * search (open_page) enabled — not one call per source.
 */
import { log } from "../logger.js";
import { respond } from "../openai.js";
import { sameUrl } from "../registry.js";
import { extractPrompt, SYSTEM_CORE } from "../prompts.js";
import type { ProductInput } from "../products.js";
import {
  ExtractionResult,
  type CollectedSource,
  type DiscoveredCandidate,
  type Failure,
  type ResearchPlan,
} from "../schema.js";

export interface ExtractionOutcome {
  collected: CollectedSource[];
  failures: Failure[];
  webSearchCalls: number;
}

export async function extractReviews(
  product: ProductInput,
  plan: ResearchPlan,
  selected: DiscoveredCandidate[],
): Promise<ExtractionOutcome> {
  if (selected.length === 0) {
    return { collected: [], failures: [], webSearchCalls: 0 };
  }

  const slim = selected.map((s) => ({ source_name: s.source_name, url: s.url }));

  const { data, webSearchCalls } = await respond({
    label: "extract",
    instructions: SYSTEM_CORE,
    input: extractPrompt(product, plan, slim),
    schema: ExtractionResult,
    schemaName: "extraction_result",
    webSearch: true,
    searchContextSize: "medium",
    maxToolCalls: selected.length * 3 + 2,
    maxOutputTokens: 16_000,
  });

  const returned = data.sources.map((s) => ({ ...s, match_confidence: clamp01(s.match_confidence) }));

  // Line each returned source up with the page we asked for (by URL, then order).
  const collected: CollectedSource[] = [];
  const failures: Failure[] = [];
  const usedIdx = new Set<number>();

  selected.forEach((want, i) => {
    let idx = returned.findIndex((r, j) => !usedIdx.has(j) && sameUrl(r.source_url, want.url));
    if (idx < 0 && !usedIdx.has(i) && returned[i]) idx = i;
    if (idx < 0) {
      failures.push({
        source: want.source_name,
        url: want.url,
        reason: "Model returned no extraction result for this page.",
      });
      log.ui(`  ! ${want.source_name}: no result returned`);
      return;
    }
    usedIdx.add(idx);
    const row = returned[idx]!;
    // Trust the identity we sent.
    row.source_url = want.url;
    row.source_name = want.source_name;
    collected.push(row);

    log.ui(
      `  -> ${row.source_name}: ${row.match_status} ${row.match_confidence.toFixed(2)}, ` +
        `${row.extraction_status}` +
        (row.rating != null ? `, rating ${row.rating}/${row.rating_scale ?? "?"}` : "") +
        (row.review_count != null ? `, ${row.review_count} reviews` : ""),
    );

    if (row.extraction_status === "FAILED" || row.extraction_status === "BLOCKED") {
      failures.push({
        source: row.source_name,
        url: row.source_url,
        reason:
          row.notes ??
          (row.extraction_status === "BLOCKED"
            ? "Page gated (login/captcha/paywall/anti-bot) — not bypassed."
            : "Could not access or parse the page."),
      });
    }
  });

  return { collected, failures, webSearchCalls };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
