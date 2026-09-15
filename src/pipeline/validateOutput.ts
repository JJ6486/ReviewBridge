/**
 * Deterministic guards on top of the Zod schema — the last line of defence
 * against hallucinated or mis-attributed data. Returns a validated FinalReport
 * or throws. No model calls here.
 */
import { log } from "../logger.js";
import { FinalReport, type AverageRating, type FinalSource } from "../schema.js";

/** LIKELY_MATCH is only usable at/above this confidence. */
export const LIKELY_MATCH_MIN_CONFIDENCE = 0.7;

export function isUsableMatch(s: {
  match_status: string;
  match_confidence: number;
}): boolean {
  if (s.match_status === "EXACT_MATCH") return true;
  if (s.match_status === "LIKELY_MATCH") return s.match_confidence >= LIKELY_MATCH_MIN_CONFIDENCE;
  return false;
}

export function validateOutput(draft: unknown): FinalReport {
  const report = FinalReport.parse(draft); // 1. structural
  const warnings = new Set(report.warnings);

  for (const s of report.sources) guardSource(s, warnings); // 2. per-source

  // 3. recompute derived fields from the guarded data — never trust the model.
  const usable = report.sources.filter((s) => s.included_in_analysis && isUsableMatch(s));
  report.sources.forEach((s) => {
    s.included_in_analysis = usable.includes(s);
  });
  report.overall.total_valid_sources = usable.length;
  report.overall.combined_rating = null;

  // 4. cross-field consistency.
  if (report.research_status === "SUCCESS" && usable.length === 0) {
    report.research_status = "NO_RELIABLE_SOURCES";
    warnings.add("research_status downgraded: no source met the match-confidence bar.");
  }
  if (usable.length === 0) {
    report.overall.sentiment = report.overall.sentiment ?? "INSUFFICIENT_DATA";
  }
  if (usable.length === 0 && report.pros.length + report.cons.length > 0) {
    warnings.add("pros/cons present with zero valid sources — cleared.");
    report.pros = [];
    report.cons = [];
  }

  const rated = usable.filter((s) => s.rating != null).length;
  report.overall.combined_rating_note =
    rated >= 2
      ? `Per-source ratings only (this PoC does not compute a combined rating). ${rated} valid source(s) carry a product rating.`
      : `No combined rating: only ${rated} valid source(s) with a product rating. Per-source ratings are the reliable signal.`;

  // 4b. weighted average star rating — arithmetic over already-guardrailed
  // source ratings only, never model-generated. See computeAverageRating().
  report.overall.average_rating = computeAverageRating(usable);

  report.warnings = [...warnings];

  const finalReport = FinalReport.parse(report); // 5. re-validate after mutation
  const avg = finalReport.overall.average_rating;
  log.ui(
    `valid: ${finalReport.overall.total_valid_sources}/${finalReport.sources.length} sources, ` +
      `${finalReport.failures.length} failure(s), ${finalReport.warnings.length} warning(s)` +
      (avg.value != null ? ` — average rating ${avg.value}/5 (${avg.review_count} reviews)` : ""),
  );
  return finalReport;
}

/**
 * Weighted average, normalised to /5. Weighted by each source's review_count
 * (unknown counts weigh as 1) — a page with 200 reviews should outweigh one
 * with 2. Only ever reads `rating`/`rating_scale`/`review_count` fields that
 * already survived `guardSource` above, so this can't surface a rating the
 * per-source guardrails already rejected.
 */
function computeAverageRating(usable: FinalSource[]): AverageRating {
  const rated = usable.filter((s) => s.rating != null);
  if (rated.length === 0) {
    return {
      value: null,
      scale: 5,
      review_count: 0,
      sources_with_rating: 0,
      method: "INSUFFICIENT_DATA",
      note: "No valid source carried a confirmed product rating.",
    };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  let reviewCountSum = 0;
  for (const s of rated) {
    const scale = s.rating_scale ?? 5;
    const normalised = scale > 0 ? (s.rating! / scale) * 5 : s.rating!;
    const weight = s.review_count != null && s.review_count > 0 ? s.review_count : 1;
    weightedSum += normalised * weight;
    weightTotal += weight;
    reviewCountSum += s.review_count ?? 0;
  }
  const value = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 10) / 10 : null;

  return {
    value,
    scale: 5,
    review_count: reviewCountSum,
    sources_with_rating: rated.length,
    method: "WEIGHTED_BY_REVIEW_COUNT",
    note:
      `Weighted average of ${rated.length} source rating(s), each normalised to /5 and weighted ` +
      `by its review count (an unknown count weighs as 1). ${reviewCountSum} known review(s) ` +
      "contributed across those sources.",
  };
}

function guardSource(s: FinalSource, warnings: Set<string>): void {
  s.match_confidence = clamp01(s.match_confidence);

  if (!s.source_url || !/^https?:\/\//i.test(s.source_url)) {
    warnings.add(`Source "${s.source_name}" has no valid URL — data not trustworthy.`);
    s.extraction_status = "FAILED";
  }

  // Drop a "rating" that isn't confirmed as the PRODUCT's own rating.
  if (s.rating != null && s.rating_is_product_rating !== true) {
    warnings.add(
      `Discarded rating ${s.rating} from "${s.source_name}": not confirmed as the product's own rating.`,
    );
    s.rating = null;
    s.rating_scale = null;
  }

  // Range sanity vs scale.
  if (s.rating != null) {
    const scale = s.rating_scale ?? 5;
    if (s.rating < 0 || s.rating > scale) {
      warnings.add(`Dropped out-of-range rating ${s.rating}/${scale} from "${s.source_name}".`);
      s.rating = null;
      s.rating_scale = null;
    }
  }

  if (s.review_count != null && (s.review_count < 0 || !Number.isFinite(s.review_count))) {
    s.review_count = null;
  }

  // seller/brand ratings must never masquerade as the product rating.
  if (s.seller_rating != null && s.seller_rating === s.rating) {
    warnings.add(`"${s.source_name}": product rating equals seller rating — cleared product rating.`);
    s.rating = null;
    s.rating_scale = null;
  }

  if (!isUsableMatch(s)) s.included_in_analysis = false;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
