/**
 * CLI entrypoint.
 *
 *   npm start        # research every product in ACTIVE_PRODUCTS (src/products.ts)
 *
 * Loops over the product list via `runBatch` (shared with the web UI in
 * server.ts), printing a per-product summary and a batch cost total, and
 * writing one JSON report per product to ./output.
 */
import { config } from "./config.js";
import { log } from "./logger.js";
import { ACTIVE_PRODUCTS } from "./products.js";
import type { FinalReport } from "./schema.js";
import { runBatch, type BatchEntry } from "./batchRunner.js";

async function main(): Promise<void> {
  const products = ACTIVE_PRODUCTS;

  log.info("ReviewBridge — Product Review Intelligence Agent (PoC)");
  log.info("Provider: OpenAI");
  log.info(`Model: ${config.openaiModel}`);
  log.info(`Max sources: ${config.maxSources}`);
  log.info("Search strategy: OpenAI native web search");
  log.info(`Batch size: ${products.length} product(s)`);
  console.log();

  const batch = await runBatch(products, () => console.log());
  for (const b of batch) {
    if (b.report) {
      printSummary(b.report);
      console.log();
    }
  }

  printBatchSummary(batch);

  if (batch.every((b) => b.report == null)) process.exitCode = 1;
}

function printSummary(r: FinalReport): void {
  const line = "─".repeat(66);
  const u = r.usage;

  console.log(line);
  console.log(`Product:                 ${r.product.requested_name}`);
  if (r.product.canonical_name) console.log(`Identified as:           ${r.product.canonical_name}`);
  console.log(`Brand / model:           ${r.product.identified_brand ?? "?"} / ${r.product.identified_model ?? "?"}`);
  console.log(`Research status:         ${r.research_status}`);
  console.log(`Candidates found:        ${r.meta.candidates_discovered}`);
  console.log(`Sources selected:        ${r.meta.sources_selected}`);
  console.log(`Sources analyzed:        ${r.meta.sources_analyzed}`);
  console.log(`Valid product matches:   ${r.overall.total_valid_sources}`);
  console.log(line);

  for (const s of r.sources) {
    const tag = s.included_in_analysis ? "✓ VALID" : `· ${s.match_status}`;
    console.log(`\n[${tag}] ${s.source_name}`);
    console.log(`  URL:            ${s.source_url}`);
    console.log(`  Product found:  ${s.product_name_found ?? "(unclear)"}`);
    console.log(`  Match:          ${s.match_status} (confidence ${s.match_confidence.toFixed(2)})`);
    console.log(`  Product rating: ${s.rating != null ? `${s.rating} / ${s.rating_scale ?? "?"}` : "null"}`);
    if (s.seller_rating != null) console.log(`  Seller rating:  ${s.seller_rating} (kept separate)`);
    if (s.brand_rating != null) console.log(`  Brand rating:   ${s.brand_rating} (kept separate)`);
    console.log(`  Review count:   ${s.review_count ?? "null"}`);
    if (s.publication_date) console.log(`  Published:      ${s.publication_date}`);
    console.log(`  Extraction:     ${s.extraction_status}`);
    if (s.review_summary) console.log(`  Summary:        ${s.review_summary}`);
  }

  console.log(`\n${line}`);
  console.log(`Overall sentiment:       ${r.overall.sentiment ?? "null"}`);
  if (r.overall.summary) console.log(`Overall summary:         ${r.overall.summary}`);

  console.log(`\nCommon pros:`);
  if (r.pros.length) r.pros.forEach((p) => console.log(`  + ${p}`));
  else console.log(`  (none — insufficient data)`);
  console.log(`\nCommon cons:`);
  if (r.cons.length) r.cons.forEach((c) => console.log(`  - ${c}`));
  else console.log(`  (none — insufficient data)`);

  if (r.failures.length) {
    console.log(`\nAccess failures:`);
    r.failures.forEach((f) => console.log(`  ! ${f.source} — ${f.reason}`));
  }
  if (r.warnings.length) {
    console.log(`\nWarnings:`);
    r.warnings.forEach((w) => console.log(`  * ${w}`));
  }

  console.log(`\n${line}`);
  console.log("USAGE & COST");
  console.log(`  API requests:          ${u.api_requests}`);
  console.log(`  Web searches:          ${u.web_search_calls}`);
  console.log(`  Input tokens:          ${u.input_tokens}${u.cached_input_tokens ? ` (${u.cached_input_tokens} cached)` : ""}`);
  console.log(`  Output tokens:         ${u.output_tokens}${u.reasoning_tokens ? ` (${u.reasoning_tokens} reasoning)` : ""}`);
  console.log(`  Total tokens:          ${u.total_tokens}`);
  console.log(
    `  Estimated API cost:    ${u.estimated_cost_usd != null ? `$${u.estimated_cost_usd.toFixed(4)}` : "unknown (no pricing for model)"}`,
  );
  if (u.estimated_cost_usd != null) {
    const b = u.cost_breakdown_usd;
    console.log(
      `                         (input $${b.input.toFixed(4)} + cached $${b.cached_input.toFixed(4)} + output $${b.output.toFixed(4)} + web search $${b.web_search.toFixed(4)})`,
    );
  }
  console.log(`  Note: ${u.notes}`);
  console.log(line);
}

function printBatchSummary(batch: BatchEntry[]): void {
  const line = "═".repeat(66);
  const succeeded = batch.filter((b) => b.report != null);
  const failed = batch.filter((b) => b.report == null);

  console.log(line);
  console.log("BATCH SUMMARY");
  console.log(line);
  for (const b of batch) {
    const status = b.report ? b.report.research_status : "ERROR";
    const cost = b.report?.usage.estimated_cost_usd;
    console.log(
      `  ${status.padEnd(22)} ${b.product.name}` +
        (cost != null ? ` — $${cost.toFixed(4)}` : b.error ? ` — ${b.error}` : ""),
    );
  }

  if (succeeded.length) {
    const totals = succeeded.reduce(
      (acc, b) => {
        const u = b.report!.usage;
        acc.apiRequests += u.api_requests;
        acc.webSearches += u.web_search_calls;
        acc.inputTokens += u.input_tokens;
        acc.outputTokens += u.output_tokens;
        acc.totalTokens += u.total_tokens;
        if (u.estimated_cost_usd != null) acc.cost += u.estimated_cost_usd;
        else acc.costUnknown = true;
        return acc;
      },
      { apiRequests: 0, webSearches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, costUnknown: false },
    );

    console.log(line);
    console.log(`  Products succeeded:    ${succeeded.length}/${batch.length}`);
    console.log(`  Total API requests:    ${totals.apiRequests}`);
    console.log(`  Total web searches:    ${totals.webSearches}`);
    console.log(`  Total tokens:          ${totals.totalTokens} (${totals.inputTokens} in / ${totals.outputTokens} out)`);
    console.log(
      `  Total estimated cost:  $${totals.cost.toFixed(4)}${totals.costUnknown ? " (+ unpriced model(s), see notes above)" : ""}`,
    );
  }
  if (failed.length) {
    console.log(`  Products failed:       ${failed.length}/${batch.length}`);
  }
  console.log(line);
}

void main();
