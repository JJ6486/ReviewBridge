/**
 * Review Source Registry.
 *
 * A persistent, per-product-identity record of which URLs actually turned out
 * to hold genuine product-specific reviews, and which didn't — so repeat
 * research on the same product can try known-good sources first and skip
 * re-discovering known-dead ones, instead of paying for fresh web search every
 * time.
 *
 * PoC-friendly on purpose: one JSON file on disk (`config.registryPath`),
 * loaded/saved with plain `fs`, validated with the same Zod pattern as
 * everything else in this project. No database, no server.
 *
 * A URL only ever becomes `TRUSTED` after `extractReviews` has actually opened
 * it and confirmed real review content — appearing in search results is never
 * enough (mirrors the discovery `select` guardrail).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod/v4";
import { config } from "./config.js";
import { log } from "./logger.js";
import { isUsableMatch } from "./pipeline/validateOutput.js";
import {
  ExtractionStatus,
  MatchStatus,
  SourceType,
  type CollectedSource,
  type DiscoveredCandidate,
} from "./schema.js";

/* ---------------- schema ---------------- */

export const RegistryStatus = z.enum([
  "TRUSTED", // extraction confirmed genuine product-specific review content
  "NO_REVIEWS", // page matched the product but had no review content
  "PRODUCT_CHANGED", // page no longer matches this product (re-platformed / re-listed)
  "URL_DEAD", // couldn't be accessed / parsed
  "BLOCKED", // gated (login/captcha/paywall/anti-bot) — never bypassed
  "REJECTED_MATCH", // reviews were present but the match confidence was too low to trust
]);
export type RegistryStatus = z.infer<typeof RegistryStatus>;

const ProductIdentity = z.object({
  brand: z.string().nullable(),
  canonical_name: z.string().nullable(),
  requested_name: z.string(),
  sku: z.string().nullable(),
});
export type ProductIdentity = z.infer<typeof ProductIdentity>;

export const RegistryEntry = z.object({
  url: z.string(), // normalised canonical URL — part of the identity key
  domain: z.string(),
  product_key: z.string(),
  product_identity: ProductIdentity,

  source_name: z.string(),
  source_type: SourceType,
  status: RegistryStatus,

  match_status: MatchStatus,
  match_confidence: z.number(),
  match_reasoning: z.string(),

  /** The PRODUCT's own rating/count only — same guardrail as CollectedSource. */
  rating: z.number().nullable(),
  rating_scale: z.number().nullable(),
  review_count: z.number().nullable(),
  rating_is_product_rating: z.boolean().nullable(),
  seller_rating: z.number().nullable(),
  brand_rating: z.number().nullable(),

  review_summary: z.string().nullable(),
  positive_points: z.array(z.string()),
  negative_points: z.array(z.string()),

  extraction_status: ExtractionStatus,
  notes: z.string().nullable(),

  first_seen: z.string(), // ISO
  last_checked: z.string(), // ISO — when extraction last actually verified this URL
  times_reused: z.number().int(), // cache hits since first_seen (never re-verified for these)
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

const RegistryFile = z.object({
  version: z.literal(1),
  entries: z.array(RegistryEntry),
});

/* ---------------- URL normalisation / identity ---------------- */

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "dclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "referrer",
  "_pos",
  "_sid",
  "_ss",
]);
// Deliberately NOT stripped: params like `variant` that can select a different
// product variant/SKU on some storefronts — stripping those would risk
// conflating two different products under one URL identity.

/** Normalise a URL for dedup/identity: scheme+host lowercased, no `www.`, no
 * fragment, tracking params dropped, remaining params sorted, trailing slash
 * trimmed. Returns null if the string isn't a usable URL. */
export function normalizeUrl(raw: string): { url: string; domain: string } | null {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  u.hash = "";
  for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
  const sortedParams = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of sortedParams) u.searchParams.append(k, v);
  const domain = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return { url: `${u.protocol}//${domain}${path}${u.search}`, domain };
}

/** Scheme-agnostic identity key — for Set/Map membership only, never for fetching. */
export function dedupeKey(raw: string): string | null {
  const n = normalizeUrl(raw);
  return n ? n.url.replace(/^https?:\/\//, "") : null;
}

export function sameUrl(a: string, b: string): boolean {
  const ka = dedupeKey(a);
  const kb = dedupeKey(b);
  return Boolean(ka && kb && ka === kb);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Product identity key — the requested name plus SKU when available,
 * deliberately NOT SKU alone (a SKU may be missing, or the requester may only
 * have a name). Built from `ProductInput` — the caller-supplied, deterministic
 * fields — rather than the model's `identified_brand` / `canonical_name`,
 * which are free text the model rephrases slightly on every run (confirmed by
 * testing: the same product produced two different canonical-name strings
 * across two back-to-back runs). This is what gets written to `product_key`
 * on each entry, for humans reading the registry file — lookups themselves
 * go through `identityMatches` below, not string equality on this key.
 */
export function computeProductKey(identity: {
  requested_name: string;
  sku: string | null;
}): string {
  const name = slug(identity.requested_name);
  const sku = identity.sku ? slug(identity.sku) : "";
  return sku ? `${name}__${sku}` : name;
}

/**
 * Whether an existing registry entry's identity should be treated as "the
 * same product" as the identity of the current request.
 *
 * OR, not AND: a SKU match alone is enough (two listings can be phrased
 * completely differently and still be the same SKU), and a name match alone
 * is enough (a product may have no SKU at all). This replaced matching on
 * the combined `product_key` string, which required the SKU (when present)
 * AND the exact name text to both line up — so a request with a known SKU
 * but slightly different name text, or vice versa, missed the cache
 * entirely. Name comparison goes through `slug()`, so blank-space/casing/
 * punctuation-only differences never break the match — but this is still
 * exact-name matching otherwise: "...Electric Portable" and "...Electric
 * Portable Heater" are different strings, not a spacing difference, so
 * without a shared SKU they are still treated as different products and
 * will NOT share cached sources.
 */
function identityMatches(
  entry: { requested_name: string; sku: string | null },
  identity: { requested_name: string; sku: string | null },
): boolean {
  if (entry.sku && identity.sku && slug(entry.sku) === slug(identity.sku)) return true;
  return slug(entry.requested_name) === slug(identity.requested_name);
}

/* ---------------- status derivation ---------------- */

/** What should a just-extracted source be filed as? */
export function statusFromExtraction(s: CollectedSource): RegistryStatus {
  if (s.extraction_status === "BLOCKED") return "BLOCKED";
  if (s.extraction_status === "FAILED") return "URL_DEAD";
  if (s.match_status === "NO_MATCH") return "PRODUCT_CHANGED";
  const hasReviewEvidence =
    s.rating != null ||
    s.review_count != null ||
    Boolean(s.review_summary) ||
    s.review_excerpts.length > 0;
  if (!hasReviewEvidence) return "NO_REVIEWS";
  if (!isUsableMatch(s)) return "REJECTED_MATCH";
  return "TRUSTED";
}

/* ---------------- registry store ---------------- */

export class ReviewSourceRegistry {
  private entries: RegistryEntry[] = [];
  private loaded = false;
  private dirty = false;

  async load(): Promise<void> {
    if (this.loaded || !config.registryEnabled) {
      this.loaded = true;
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(config.registryPath, "utf8");
      const parsed = RegistryFile.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.entries = parsed.data.entries;
      } else {
        log.warn(
          `registry file "${config.registryPath}" failed validation — starting empty this run ` +
            `(${parsed.error.issues[0]?.message ?? "invalid shape"})`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`could not read registry "${config.registryPath}" — starting empty: ${(err as Error).message}`);
      }
    }
  }

  async save(): Promise<void> {
    if (!config.registryEnabled || !this.dirty) return;
    const file: z.infer<typeof RegistryFile> = { version: 1, entries: this.entries };
    await mkdir(dirname(config.registryPath), { recursive: true });
    const tmp = `${config.registryPath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
    await rename(tmp, config.registryPath);
    this.dirty = false;
  }

  private forProduct(identity: { requested_name: string; sku: string | null }): RegistryEntry[] {
    return this.entries.filter((e) => identityMatches(e.product_identity, identity));
  }

  /** Trusted sources for a product, best (confidence, then review count) first. */
  getTrusted(identity: { requested_name: string; sku: string | null }): RegistryEntry[] {
    return this.forProduct(identity)
      .filter((e) => e.status === "TRUSTED")
      .sort(
        (a, b) => b.match_confidence - a.match_confidence || (b.review_count ?? 0) - (a.review_count ?? 0),
      );
  }

  /** Everything on file for this product that is NOT currently trusted. */
  getKnownBad(identity: { requested_name: string; sku: string | null }): RegistryEntry[] {
    return this.forProduct(identity).filter((e) => e.status !== "TRUSTED");
  }

  isFresh(entry: RegistryEntry): boolean {
    const ageMs = Date.now() - Date.parse(entry.last_checked);
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < config.registryTtlHours * 3_600_000;
  }

  /** Mark a cache hit — reused without re-verification this run. */
  markReused(url: string, identity: { requested_name: string; sku: string | null }): void {
    const key = dedupeKey(url);
    const e = this.entries.find(
      (x) => identityMatches(x.product_identity, identity) && dedupeKey(x.url) === key,
    );
    if (e) {
      e.times_reused += 1;
      this.dirty = true;
    }
  }

  /** Insert or update the record for one (product, URL) after extraction. */
  upsert(input: {
    url: string;
    product_key: string;
    product_identity: ProductIdentity;
    source_name: string;
    source_type: SourceType;
    status: RegistryStatus;
    match_status: MatchStatus;
    match_confidence: number;
    match_reasoning: string;
    rating: number | null;
    rating_scale: number | null;
    review_count: number | null;
    rating_is_product_rating: boolean | null;
    seller_rating: number | null;
    brand_rating: number | null;
    review_summary: string | null;
    positive_points: string[];
    negative_points: string[];
    extraction_status: ExtractionStatus;
    notes: string | null;
  }): void {
    const norm = normalizeUrl(input.url);
    if (!norm) return; // not a real URL — nothing to persist
    const now = new Date().toISOString();
    const key = dedupeKey(norm.url);
    const idx = this.entries.findIndex(
      (e) => identityMatches(e.product_identity, input.product_identity) && dedupeKey(e.url) === key,
    );
    const prev = idx >= 0 ? this.entries[idx] : undefined;
    const entry: RegistryEntry = {
      ...input,
      url: norm.url,
      domain: norm.domain,
      first_seen: prev?.first_seen ?? now,
      last_checked: now,
      times_reused: prev?.times_reused ?? 0,
    };
    if (idx >= 0) this.entries[idx] = entry;
    else this.entries.push(entry);
    this.dirty = true;
  }
}

export const registry = new ReviewSourceRegistry();

/* ---------------- conversions to/from the live pipeline types ---------------- */

/** Feed a trusted-but-stale entry back into extraction as if it were freshly discovered. */
export function candidateFromEntry(e: RegistryEntry): DiscoveredCandidate {
  return {
    source_name: e.source_name,
    url: e.url,
    source_type: e.source_type,
    snippet: `From the review-source registry (last verified ${e.last_checked.slice(0, 10)}).`,
    contains_reviews: true,
    match_status: e.match_status,
    match_confidence: e.match_confidence,
    match_reasoning: e.match_reasoning,
    select: true,
    select_reason: "Known trusted source from a previous run.",
  };
}

/** Reuse a fresh trusted entry directly, with no re-extraction this run. */
export function collectedSourceFromEntry(e: RegistryEntry): CollectedSource {
  return {
    source_name: e.source_name,
    source_url: e.url,
    product_name_found: e.product_identity.canonical_name,
    match_status: e.match_status,
    match_confidence: e.match_confidence,
    match_reasoning: `${e.match_reasoning} [reused from registry; last verified ${e.last_checked.slice(0, 10)}]`,
    rating: e.rating,
    rating_scale: e.rating_scale,
    review_count: e.review_count,
    rating_is_product_rating: e.rating_is_product_rating,
    seller_rating: e.seller_rating,
    brand_rating: e.brand_rating,
    publication_date: null,
    review_summary: e.review_summary,
    positive_points: e.positive_points,
    negative_points: e.negative_points,
    review_excerpts: [], // verbatim excerpts aren't cached — kept lean, never invented
    extraction_status: e.extraction_status,
    notes: `Reused from review-source registry without re-fetching (cached ${new Date().toDateString()}).`,
  };
}
