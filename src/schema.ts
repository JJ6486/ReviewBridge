/**
 * Schema Validation.
 *
 * Every structured value produced by the model is described here with Zod and
 * validated before it is trusted. The final report is validated once more (plus
 * deterministic guards) in `pipeline/validateOutput.ts`.
 *
 * Schemas passed to OpenAI structured outputs (ResearchPlan, DiscoveryResult,
 * ExtractionResult, AnalysisResult) avoid `.min()/.max()` — range checks live in
 * `validateOutput.ts`.
 */
import { z } from "zod/v4";

/* ---------- shared enums ---------- */

export const MatchStatus = z.enum(["EXACT_MATCH", "LIKELY_MATCH", "UNCERTAIN", "NO_MATCH"]);
export type MatchStatus = z.infer<typeof MatchStatus>;

export const ExtractionStatus = z.enum([
  "SUCCESS", // review data extracted
  "PARTIAL", // some fields found, others missing
  "NO_REVIEWS_FOUND", // page reached, product matched, but no public reviews
  "BLOCKED", // login / captcha / paywall / anti-bot — not bypassed
  "FAILED", // could not access or parse
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatus>;

export const Sentiment = z.enum([
  "VERY_POSITIVE",
  "MOSTLY_POSITIVE",
  "MIXED",
  "MOSTLY_NEGATIVE",
  "VERY_NEGATIVE",
  "INSUFFICIENT_DATA",
]);
export type Sentiment = z.infer<typeof Sentiment>;

export const ResearchStatus = z.enum([
  "SUCCESS", // >= 1 valid source with review data
  "PARTIAL", // product identified, sources found, but little/no review data
  "NO_RELIABLE_SOURCES", // nothing matched with enough confidence
  "PRODUCT_NOT_IDENTIFIED",
  "FAILED",
]);
export type ResearchStatus = z.infer<typeof ResearchStatus>;

export const SourceType = z.enum([
  "REVIEW_SITE", // specialist / editorial review site
  "RETAILER", // shop product page with customer reviews
  "MANUFACTURER", // brand's own site
  "BLOG_OR_MAGAZINE",
  "FORUM", // community discussion
  "MARKETPLACE",
  "VIDEO",
  "OTHER",
]);
export type SourceType = z.infer<typeof SourceType>;

/* ---------- step 1: research plan (product understanding + search queries) ---------- */

export const ResearchPlan = z.object({
  identified: z.boolean(),
  identified_brand: z.string().nullable(),
  identified_model: z.string().nullable(),
  canonical_name: z.string().nullable(),
  key_specs: z.array(z.string()),
  distinguishing_features: z.array(z.string()),
  /** Similar names / variants / other brands the research must NOT confuse this with. */
  likely_confusions: z.array(z.string()),
  /** 3–5 deliberate, review-focused search queries built from the product name. */
  search_queries: z.array(z.string()),
  reasoning: z.string(),
});
export type ResearchPlan = z.infer<typeof ResearchPlan>;

/* ---------- step 2: discovery (web search -> classified candidates) ---------- */

export const DiscoveredCandidate = z.object({
  source_name: z.string(),
  url: z.string(),
  source_type: SourceType,
  /** Short snippet / description seen in the search results. */
  snippet: z.string().nullable(),
  /** Does this page look like it contains ACTUAL review content (not just specs)? */
  contains_reviews: z.boolean(),
  /** Preliminary product-match judgement from search-result information only. */
  match_status: MatchStatus,
  match_confidence: z.number(),
  match_reasoning: z.string(),
  /** Should this be collected/analysed? (true only for real, on-topic review pages) */
  select: z.boolean(),
  select_reason: z.string(),
});
export type DiscoveredCandidate = z.infer<typeof DiscoveredCandidate>;

export const DiscoveryResult = z.object({
  queries_run: z.array(z.string()),
  candidates: z.array(DiscoveredCandidate),
  notes: z.string(),
});
export type DiscoveryResult = z.infer<typeof DiscoveryResult>;

/* ---------- step 4: extraction (open selected pages -> review data) ---------- */

export const ReviewExcerpt = z.object({
  text: z.string(),
  rating: z.number().nullable(),
  attributed_to: z.string().nullable(),
  date: z.string().nullable(),
});
export type ReviewExcerpt = z.infer<typeof ReviewExcerpt>;

export const CollectedSource = z.object({
  source_name: z.string(),
  source_url: z.string(),
  product_name_found: z.string().nullable(),

  match_status: MatchStatus,
  match_confidence: z.number(),
  match_reasoning: z.string(),

  /** The PRODUCT rating only — never a seller/store/brand/site rating. */
  rating: z.number().nullable(),
  rating_scale: z.number().nullable(),
  review_count: z.number().nullable(),
  /** `true` only when `rating` is clearly the product's own rating. */
  rating_is_product_rating: z.boolean().nullable(),

  /** Recorded separately so they can never be mistaken for the product rating. */
  seller_rating: z.number().nullable(),
  brand_rating: z.number().nullable(),

  publication_date: z.string().nullable(),
  review_summary: z.string().nullable(),
  positive_points: z.array(z.string()),
  negative_points: z.array(z.string()),
  review_excerpts: z.array(ReviewExcerpt),

  extraction_status: ExtractionStatus,
  notes: z.string().nullable(),
});
export type CollectedSource = z.infer<typeof CollectedSource>;

export const ExtractionResult = z.object({
  sources: z.array(CollectedSource),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/* ---------- step 5: analysis ---------- */

export const AnalysisResult = z.object({
  sentiment: Sentiment,
  summary: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  has_enough_data_for_overall_rating: z.boolean(),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;

/* ---------- usage / cost ---------- */

export const UsageSummary = z.object({
  api_requests: z.number().int(),
  web_search_calls: z.number().int(),
  input_tokens: z.number().int(),
  cached_input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  reasoning_tokens: z.number().int(),
  total_tokens: z.number().int(),
  estimated_cost_usd: z.number().nullable(),
  cost_breakdown_usd: z.object({
    input: z.number(),
    cached_input: z.number(),
    output: z.number(),
    web_search: z.number(),
  }),
  pricing_model: z.string(),
  pricing_known: z.boolean(),
  notes: z.string(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/* ---------- final report ---------- */

export const FinalSource = CollectedSource.extend({
  /** Decided in code: did this source feed the overall analysis? */
  included_in_analysis: z.boolean(),
});
export type FinalSource = z.infer<typeof FinalSource>;

export const Failure = z.object({
  source: z.string(),
  url: z.string().nullable(),
  reason: z.string(),
});
export type Failure = z.infer<typeof Failure>;

/**
 * Deterministically computed in `validateOutput.ts` from already-guardrailed
 * source ratings only (never model-generated) — see that file for the formula.
 */
export const AverageRating = z.object({
  /** Weighted mean, normalised to a /5 scale. null if no valid source has a rating. */
  value: z.number().nullable(),
  scale: z.literal(5),
  /** Sum of the real review_count values reported by contributing sources. */
  review_count: z.number().int().min(0),
  /** How many valid sources contributed a rating to this figure. */
  sources_with_rating: z.number().int().min(0),
  method: z.enum(["WEIGHTED_BY_REVIEW_COUNT", "INSUFFICIENT_DATA"]),
  note: z.string(),
});
export type AverageRating = z.infer<typeof AverageRating>;

export const FinalReport = z.object({
  product: z.object({
    requested_name: z.string(),
    sku: z.string().nullable(),
    model: z.string().nullable(),
    identified_brand: z.string().nullable(),
    identified_model: z.string().nullable(),
    canonical_name: z.string().nullable(),
  }),

  research_status: ResearchStatus,

  overall: z.object({
    sentiment: Sentiment.nullable(),
    summary: z.string().nullable(),
    total_valid_sources: z.number().int().min(0),
    combined_rating: z.null(),
    combined_rating_note: z.string(),
    average_rating: AverageRating,
  }),

  pros: z.array(z.string()),
  cons: z.array(z.string()),

  sources: z.array(FinalSource),
  failures: z.array(Failure),
  warnings: z.array(z.string()),

  usage: UsageSummary,

  meta: z.object({
    provider: z.literal("openai"),
    model: z.string(),
    search_strategy: z.string(),
    generated_at: z.string(),
    run_seconds: z.number(),
    search_queries: z.array(z.string()),
    candidates_discovered: z.number().int().min(0),
    sources_selected: z.number().int().min(0),
    sources_analyzed: z.number().int().min(0),
    registry: z.object({
      enabled: z.boolean(),
      product_key: z.string(),
      known_trusted: z.number().int().min(0),
      known_bad: z.number().int().min(0),
      reused_from_cache: z.number().int().min(0),
      refreshed: z.number().int().min(0),
      skipped_known_bad: z.number().int().min(0),
      new_sources_recorded: z.number().int().min(0),
      web_discovery_skipped: z.boolean(),
      estimated_cost_saved_usd: z.number(),
      estimated_cost_utilized_usd: z.number(),
    }),
  }),
});
export type FinalReport = z.infer<typeof FinalReport>;
