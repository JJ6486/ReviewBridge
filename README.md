# ReviewBridge — Product Review Intelligence Agent (PoC)

## 1. Purpose

A focused feasibility test:

> Given a product name and SKU, can **OpenAI's built-in web search** (Responses
> API `web_search` tool) reliably find review pages for that *exact* product, and
> can we aggregate useful review information from only **3–5 selected websites**
> at a reasonable API cost?

Single provider: **OpenAI**. No scraping, no Playwright, no external search
APIs — the whole point is to evaluate OpenAI's native web search. The output is
machine-readable JSON so it could later back a Shopify review-aggregation app.

Not in scope: Shopify, database, auth, multi-product, deployment.

---

## 2. How it works — up to 4 model calls (fewer once it's seen the product before)

```
Product (name + SKU)
        │
[1/5] plan       ── 1 OpenAI call, no tools ─────────────  understand the product +
        │                                                  build 3–5 review-focused queries
[2/5] registry   ── deterministic, no tools ─────────────  look up known sources for this
        │                                                  exact product; reuse fresh trusted
        │                                                  ones with ZERO extra API cost
        │            ┌─ sufficient? ── yes ──────────────  skip discover + extract entirely
        │            └─ no, or none on file
[3/5] discover   ── 1 OpenAI call, web_search ───────────  run the planned searches, list
        │                                                  candidate pages, classify each
        │                                                  (EXACT / LIKELY / UNCERTAIN / NO_MATCH),
        │                                                  excluding URLs already known-bad
[4/5] extract    ── 1 OpenAI call, web_search/open_page ─  refresh stale known sources and/or
        │                                                  open newly discovered pages; pull
        │                                                  rating / review count / excerpts /
        │                                                  date; re-check the product match
        │            → registry write-back ── deterministic ─ every (re-)verified source is
        │                                                  filed as TRUSTED or a failure status
[5/5] synthesize ── 1 OpenAI call, no tools ─────────────  sentiment / pros / cons from the
        │                                                  VALID sources only
        │            + validate  ── deterministic ───────  Zod + guards, recompute derived fields
        ▼
FinalReport JSON  →  ./output/<product>-<timestamp>.json  +  printed summary with cost
```

**Efficiency:** at most **4 OpenAI API requests** per product (plan, discover,
extract, synthesize — plus internal `web_search` tool actions), and as few as
**2** (plan + synthesize) once the registry already holds enough fresh trusted
sources for that exact product. Search is done by OpenAI's tool, not by an LLM
deciding to search in a loop. No autonomous/unbounded search loop. Data
transforms (URL dedup, source selection, range checks, report assembly) are
plain TypeScript — no model call is spent on them.

### Review source registry (reduces cost on repeat runs)

A URL only ever becomes a trusted source **after `extract` has actually opened
it and confirmed genuine product-specific review content** — appearing in
search results is never enough. Once trusted, it's persisted in
`data/review-source-registry.json`, keyed by **product identity** (the
requested name + SKU — not SKU alone, and never the model's free-text
`canonical_name`, which is worded slightly differently on every run and so
can't be used as a stable cache key). Failed sources are stored too —
`NO_REVIEWS`, `PRODUCT_CHANGED`, `URL_DEAD`, `BLOCKED`, `REJECTED_MATCH` — so
discovery never re-selects a URL already known not to work for that product.

On the next run for the same product:
- Trusted sources younger than `REGISTRY_TTL_HOURS` (default 7 days) are reused
  **as-is, with no API call at all**.
- Older trusted sources are re-verified via one `extract` call (still no
  `discover` call) before being reused.
- If that's still not enough (`REGISTRY_MIN_SOURCES`, default 2, usable
  matches), it falls back to normal web discovery for the shortfall, excluding
  known-bad URLs, and records whatever new sources pass extraction.

Every run logs known sources tried, which were reused vs. refreshed vs.
skipped as known-bad, how many new sources were discovered, and an **estimated
web-search cost saved or utilized** (`meta.registry` in the JSON report; see
[§7](#7-a-successful-run-looks-like) for a real before/after). URL
identity is normalised first — scheme/`www.` folded, tracking params
(`utm_*`, `gclid`, `fbclid`, `_pos`/`_sid`/`_ss`, …) stripped, fragment
dropped — while params that can select a genuinely different product variant
(e.g. `?variant=`) are left alone, so two decorated links to the same page
dedupe but two different variants never get conflated. Set `REGISTRY_ENABLED=false`
to disable it and always run full discovery.

### Key decisions

| Concern | Choice |
|---|---|
| Runtime | OpenAI SDK (`openai` v7), **Responses API** (`client.responses.parse`) |
| Search | OpenAI native **`web_search`** tool (`search_context_size: low` for discovery, `medium` for extraction). `max_tool_calls` caps it per request. |
| Page content | Comes from the web-search results / `open_page` action. Pages are **not** re-fetched by us. No CAPTCHA / login / paywall / anti-bot bypass — gated pages are recorded as `BLOCKED`. |
| Structured output | OpenAI strict structured outputs via `zodTextFormat(schema)`, then **re-validated with the same Zod schema**, then deterministic guards. |
| Model | `OPENAI_MODEL` (not hardcoded). Default `gpt-4.1-mini`; the test uses `gpt-5.6-luna`. Must support the Responses API web search tool. |
| Product matching | `EXACT_MATCH` / `LIKELY_MATCH` / `UNCERTAIN` / `NO_MATCH` + confidence + reasoning, considering brand, model/variant, SKU, wheel size, battery capacity, motor, other specs. Only `EXACT_MATCH` or `LIKELY_MATCH ≥ 0.7` feed the aggregate. An *EMU E-Haul* review is **not** an *EMU Longtail* review. |
| Cost | Every response's `usage` is captured (never guessed). Prices live only in `src/pricing.ts`. A labelled **Estimated API cost** is printed and saved. |

---

## 3. Project layout

```
src/
  config.ts                env: OPENAI_API_KEY, OPENAI_MODEL, MAX_SOURCES, LOG_LEVEL, PORT, REGISTRY_*
  logger.ts                leveled logging: console gets everything, the web UI's live
                           log panel gets a curated subset (log.ui vs log.detail)
  products.ts              ProductInput — the shape every submitted product takes
  pricing.ts               THE pricing table (per-1M token rates + $10/1k web search)
  usage.ts                 token/cost accumulator, fed by every API response
  openai.ts                OpenAI client + respond() — the one structured-call helper
  registry.ts              persistent review-source registry (data/review-source-registry.json):
                           URL normalisation, product-identity key, trusted/failed source store
  prompts.ts               all instruction text (plan / discover / extract / synthesize)
  schema.ts                all Zod schemas incl. FinalReport, UsageSummary, AverageRating
  orchestrator.ts          runs the 5 steps for one product (incl. registry reuse/write-back),
                           assembles + validates FinalReport
  batchRunner.ts           runs the pipeline once per product, in order
  reportStore.ts           writes a FinalReport to output/ as JSON
  server.ts                the app itself (node:http): serves public/index.html + job API
  pipeline/
    planResearch.ts        [1/5]
    discoverSources.ts     [2/5] + [3/5] selection
    extractReviews.ts      [4/5]
    synthesize.ts          [5/5] analysis
    validateOutput.ts      deterministic guards incl. the weighted average rating (no model call)
public/
  index.html               the single-page frontend (self-contained: inline CSS + JS, no build)
```

---

## 4. Install & run

Requires **Node.js ≥ 20**. There's no CLI mode — this is a web app.

```bash
cd review-bridge
npm install
cp .env.example .env        # then set OPENAI_API_KEY
npm run dev                 # → http://localhost:3000 (auto-restarts on file changes)
```

For a production-style run (what a host runs after deploy):

```bash
npm run build                # compiles src/ → dist/
npm start                    # node dist/server.js
```

A single self-contained page: enter **2 or more** products (name + optional
SKU), hit **Start Research**, watch live progress with a curated pipeline log,
then read the results in either **Reading view** (formatted cards — status,
average star rating, sentiment, pros/cons, per-source ratings and links) or
**JSON output** (the full machine-readable report, with a copy button). No
build step for local dev, no frontend framework — plain `node:http` + one
static HTML file (`public/index.html`).

The API key stays server-side; the browser only ever talks to
`POST /api/research` and `GET /api/research/:id`. One batch runs at a time — a
second submit while one is in flight gets a clear "already running" message.

> **Hosting note:** this is a long-running Node process with in-memory job
> state — it needs a host that keeps a process alive (Render, Railway, Fly.io,
> a VPS). It will **not** work as-is on Vercel's serverless functions (no
> persistent `.listen()`, no shared memory between invocations, and both
> `output/` and `data/review-source-registry.json` need a real filesystem).

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **yes** | — | Read from env only. Never logged. |
| `OPENAI_MODEL` | no | `gpt-4.1-mini` | Must support Responses API web search. |
| `MAX_SOURCES` | no | `5` | Max sources collected/analysed after discovery (3–5). |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SEARCH_QUERIES` | no | `5` | Target deliberate search queries (clamped 3–6). |
| `REGISTRY_ENABLED` | no | `true` | Persist/reuse review sources across runs. `false` = always run full discovery. |
| `REGISTRY_PATH` | no | `data/review-source-registry.json` | Where the registry is stored — plain JSON, no DB. |
| `REGISTRY_TTL_HOURS` | no | `168` (7 days) | A trusted source older than this is re-verified before reuse. |
| `REGISTRY_MIN_SOURCES` | no | `2` | Known usable sources needed to skip web discovery (capped at `MAX_SOURCES`). |
| `PORT` | no | `3000` | Port the server listens on. |

---

## 5. Output

Validated against `FinalReport` in [`src/schema.ts`](src/schema.ts):

```jsonc
{
  "product":  { "requested_name", "sku", "model", "identified_brand", "identified_model", "canonical_name" },
  "research_status": "SUCCESS | PARTIAL | NO_RELIABLE_SOURCES | PRODUCT_NOT_IDENTIFIED | FAILED",
  "overall":  {
    "sentiment", "summary", "total_valid_sources",
    "combined_rating": null, "combined_rating_note",     // deliberately never computed (see below)
    "average_rating": {                                  // computed in code, not by the model — see §7
      "value", "scale": 5, "review_count", "sources_with_rating", "method", "note"
    }
  },
  "pros": [], "cons": [],
  "sources": [{
    "source_name", "source_url", "product_name_found",
    "match_status", "match_confidence", "match_reasoning",
    "rating", "rating_scale", "review_count", "rating_is_product_rating",
    "seller_rating", "brand_rating",          // kept SEPARATE from product rating
    "publication_date",
    "review_summary", "positive_points", "negative_points", "review_excerpts",
    "extraction_status", "notes", "included_in_analysis"
  }],
  "failures": [{ "source", "url", "reason" }],
  "warnings": [],
  "usage": {
    "api_requests", "web_search_calls",
    "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens",
    "estimated_cost_usd",
    "cost_breakdown_usd": { "input", "cached_input", "output", "web_search" },
    "pricing_model", "pricing_known", "notes"
  },
  "meta": {
    "provider": "openai", "model", "search_strategy", "generated_at", "run_seconds",
    "search_queries": [], "candidates_discovered", "sources_selected", "sources_analyzed",
    "registry": {
      "enabled", "product_key",
      "known_trusted", "known_bad", "reused_from_cache", "refreshed", "skipped_known_bad",
      "new_sources_recorded", "web_discovery_skipped",
      "estimated_cost_saved_usd", "estimated_cost_utilized_usd"
    }
  }
}
```

`sources[]` contains every analysed source (including `NO_MATCH` / `UNCERTAIN`
for transparency). Only `included_in_analysis: true` sources feed `overall`,
`pros`, `cons`, and `average_rating`.

### Average rating — computed, not modelled

`overall.combined_rating` stays `null` on purpose (see below); `overall.average_rating`
is a **new, separate field** that answers "what's the overall star rating" without
reopening that guardrail:

- Computed **in `validateOutput.ts`, in plain TypeScript** — never by the model.
  It's arithmetic over `rating`/`rating_scale`/`review_count` fields that have
  *already* passed every per-source guard (product-rating-vs-seller-rating check,
  range check, match-confidence bar). It can't surface a number those guards
  would have rejected.
- **Weighted by review count.** Each valid source's rating is normalised to a
  /5 scale, then combined as `Σ(rating × review_count) / Σ(review_count)` — a
  page with 200 reviews outweighs one with 2. A source with an unknown review
  count weighs as 1.
- `value: null` (with `method: "INSUFFICIENT_DATA"`) when no valid source
  carries a confirmed product rating — shown in the UI as "no aggregated
  rating available", never a guessed number.
- `review_count` is the sum of the *actual* review counts reported (not the
  substituted weights), so it's an honest "N reviews", not inflated.

### Cost — read the label

`usage.estimated_cost_usd` is an **estimate**, not a bill:

- Token counts are exact (from the API `usage` object).
- Per-token rates are OpenAI's **standard / short-context** prices for the model
  (`src/pricing.ts`). A request whose input exceeds the model's short-context
  threshold is billed at a higher tier that can't be derived from `usage` alone.
- Web search is billed at **$10.00 / 1,000 calls**; every `web_search_call`
  action (`search` / `open_page` / `find_in_page`) is counted.
- If the model isn't in `src/pricing.ts`, only the web-search cost is reported
  and `pricing_known` is `false`.

---

## 6. Known limitations

- Depends entirely on what OpenAI's web search surfaces and how much page content
  it returns. If it returns thin content for a page, ratings/counts may be `null`
  — recorded honestly, never invented.
- No page is fetched outside OpenAI's tool. Gated pages → `BLOCKED`, skipped.
- Reasoning-model runs (e.g. `gpt-5.6-luna`) spend reasoning tokens; these are
  reported and priced as output tokens.
- Matching is best-effort. `match_reasoning` is always included so a human can
  check. Only `EXACT_MATCH` / `LIKELY_MATCH ≥ 0.7` are trusted for the aggregate.
- `average_rating` is one defensible methodology (weighted by review count),
  not the only one — see §5. With only 1–2 sources (typical for this PoC) it's
  really a small-sample estimate; treat it as directional, not authoritative.
- `NO_RELIABLE_SOURCES` with few/no valid sources is **also a valid PoC result** —
  it tells you the approach doesn't work well for that product.
- The registry key is `requested_name` + `sku`. If either changes in
  `products.ts` (e.g. a retitled entry), it's treated as a new product and the
  learned sources aren't carried over — a deliberate trade-off for a stable,
  debuggable cache key over a semantic one (see [§2](#review-source-registry-reduces-cost-on-repeat-runs)).
- One JSON file, no locking — fine for the sequential single-process batch this
  PoC runs; not safe for concurrent writers.

---

## 7. What a successful run looks like

The web UI's live log panel shows a curated subset of what actually runs —
enough to narrate the pipeline without the full per-candidate/per-rejection
dump (that full trail still goes to the server console, useful for your
host's function/server logs). Real, captured output for one product, fresh
(no registry cache yet):

```
[1/5] Understanding product & planning searches
      identified: H2O Hottubs / 6000 Series 32A Twin Pump 6 Person — H2O Hottubs 6000 Series 32A Twin Pump 6-Person Hot Tub
[2/5] Checking review-source registry
      0 known trusted source(s), 0 known-bad source(s) on file
[3/5] Selecting sources
      no usable known sources on file — falling back to web discovery
[4/5] Extracting review data from selected sources
      known sources still insufficient — running web discovery for the remainder
      api [discover]: 13723 in / 2118 out (326 reasoning) | 5 web-search action(s)
        search: "\"H2O Hottubs 6000 Series 32A Twin Pump 6 Person\" review"
        search: "\"H2O Hottubs 6000 Series\" reviews"
        ... (3 more)
      discovered 9 candidate page(s)
      selected 1/4 source(s) for analysis:
        + LuxEquipmentOnline - H2O Hottubs 6000 Series 32A Twin Pump Heat Pump 6 Person (EXACT_MATCH 1.00) https://...
      api [extract]: 14167 in / 933 out (616 reasoning) | 1 web-search action(s)
        -> LuxEquipmentOnline ...: EXACT_MATCH 0.98, PARTIAL, rating 4.8/5, 37 reviews
[5/5] Synthesising & validating
      sentiment: MOSTLY_POSITIVE
      pros: Powerful jets and relaxing massage | Spacious for up to six | Good value | ...
      cons: (none)
      valid: 2/2 sources, 0 failure(s), 1 warning(s) — average rating 4.8/5 (37 reviews)
```

In **Reading view**, that becomes a card headed by the product name and, right
beside it at the same size, **4.8 ★★★★★ (37 reviews)** — the weighted average
computed from those sources — followed by the sentiment badge, summary,
pros/cons, and each source with its own rating and link.

### The registry in action (real, measured — same product, back to back)

```
Run 1 (nothing on file):
      0 known trusted source(s), 0 known-bad source(s) on file
      ...full discover + extract...
      registry summary: 0 reused from cache, 0 refreshed, 0 known-bad skipped, 2 newly discovered & recorded
  USAGE & COST: 4 API requests, 7 web searches → $0.0857

Run 2 (same product, run immediately after):
      2 known trusted source(s), 0 known-bad source(s) on file
      reusing 2 fresh trusted source(s) from cache (no re-check needed):
      cached trusted sources already sufficient (2/2 needed) — skipping web discovery
      skipped — 2 source(s) served entirely from the registry cache
      valid: 2/2 sources, 0 failure(s), 0 warning(s) — average rating 4.7/5 (22 reviews)
      registry summary: 2 reused from cache, 0 refreshed, 0 known-bad skipped, 0 newly discovered & recorded,
        ~$0.0500 web-search cost saved (discovery skipped), ~$0.0200 equivalent web-search cost utilized from cache
  USAGE & COST: 2 API requests, 0 web searches → $0.0015   (98% cheaper than run 1)
```
