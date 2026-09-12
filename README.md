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

## 2. How it works — 4 model calls

```
Product (name + SKU)
        │
[1/5] plan       ── 1 OpenAI call, no tools ─────────────  understand the product +
        │                                                  build 3–5 review-focused queries
[2/5] discover   ── 1 OpenAI call, web_search ───────────  run those searches, list
        │                                                  candidate pages, classify each
        │                                                  (EXACT / LIKELY / UNCERTAIN / NO_MATCH)
[3/5] select     ── deterministic TypeScript ────────────  keep only real review pages that
        │                                                  are a confident match, best first,
        │                                                  capped at MAX_SOURCES (quality > quota)
[4/5] extract    ── 1 OpenAI call, web_search/open_page ─  open the selected pages, pull
        │                                                  rating / review count / excerpts /
        │                                                  date, re-check the product match
[5/5] synthesize ── 1 OpenAI call, no tools ─────────────  sentiment / pros / cons from the
        │                                                  VALID sources only
        │            + validate  ── deterministic ───────  Zod + guards, recompute derived fields
        ▼
FinalReport JSON  →  ./output/<product>-<timestamp>.json  +  printed summary with cost
```

**Efficiency:** exactly **4 OpenAI API requests** per product (plus internal
`web_search` tool actions). Search is done by OpenAI's tool, not by an LLM
deciding to search in a loop. No autonomous/unbounded search loop. Data
transforms (URL dedup, source selection, range checks, report assembly) are
plain TypeScript — no model call is spent on them.

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
  config.ts                env: OPENAI_API_KEY, OPENAI_MODEL, MAX_SOURCES, LOG_LEVEL
  logger.ts                leveled logging, [n/5] steps, sk-... redaction
  products.ts              hardcoded test product(s) — ACTIVE_PRODUCT
  pricing.ts               THE pricing table (per-1M token rates + $10/1k web search)
  usage.ts                 token/cost accumulator, fed by every API response
  openai.ts                OpenAI client + respond() — the one structured-call helper
  prompts.ts               all instruction text (plan / discover / extract / synthesize)
  schema.ts                all Zod schemas incl. FinalReport + UsageSummary
  orchestrator.ts          runs the 5 steps, assembles + validates FinalReport
  index.ts                 entrypoint: run, print summary + cost, write JSON
  pipeline/
    planResearch.ts        [1/5]
    discoverSources.ts     [2/5] + [3/5] selection
    extractReviews.ts      [4/5]
    synthesize.ts          [5/5] analysis
    validateOutput.ts      deterministic guards (no model call)
```

---

## 4. Install & run

Requires **Node.js ≥ 20**.

```bash
cd review-bridge
npm install
cp .env.example .env        # then set OPENAI_API_KEY
npm start
```

`npm start` researches `ACTIVE_PRODUCT` in [`src/products.ts`](src/products.ts)
(currently *EMU Longtail Electric Cargo Bike*, SKU `CAR20BF`).

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **yes** | — | Read from env only. Never logged. |
| `OPENAI_MODEL` | no | `gpt-4.1-mini` | Must support Responses API web search. |
| `MAX_SOURCES` | no | `5` | Max sources collected/analysed after discovery (3–5). |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SEARCH_QUERIES` | no | `5` | Target deliberate search queries (clamped 3–6). |

---

## 5. Output

Validated against `FinalReport` in [`src/schema.ts`](src/schema.ts):

```jsonc
{
  "product":  { "requested_name", "sku", "model", "identified_brand", "identified_model", "canonical_name" },
  "research_status": "SUCCESS | PARTIAL | NO_RELIABLE_SOURCES | PRODUCT_NOT_IDENTIFIED | FAILED",
  "overall":  { "sentiment", "summary", "total_valid_sources", "combined_rating": null, "combined_rating_note" },
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
    "search_queries": [], "candidates_discovered", "sources_selected", "sources_analyzed"
  }
}
```

`sources[]` contains every analysed source (including `NO_MATCH` / `UNCERTAIN`
for transparency). Only `included_in_analysis: true` sources feed `overall`,
`pros`, `cons`.

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
- `NO_RELIABLE_SOURCES` with few/no valid sources is **also a valid PoC result** —
  it tells you the approach doesn't work well for that product.

---

## 7. A successful run looks like

```
Provider: OpenAI
Model: gpt-5.6-luna
Max sources: 5
Search strategy: OpenAI native web search
...
Product:                 EMU Longtail Electric Cargo Bike
Research status:          SUCCESS
Candidates found:         7
Sources selected:         3
Sources analyzed:         3
Valid product matches:    2

[✓ VALID] Cycling Electric      Product rating: 4.4 / 5   Review count: 12
[✓ VALID] Example Retailer      Product rating: 4.6 / 5   Review count: 31

Overall sentiment:       MOSTLY_POSITIVE
Common pros:  + Ride stability   + Cargo capacity   + Value
Common cons:  - Weight   - Assembly

USAGE & COST
  API requests:          4
  Web searches:          8
  Input tokens:          41,200 (3,900 cached)
  Output tokens:         6,050 (2,100 reasoning)
  Total tokens:          47,250
  Estimated API cost:    $0.0900
                         (input $0.0075 + cached $0.0001 + output $0.0073 + web search $0.0800)
```
