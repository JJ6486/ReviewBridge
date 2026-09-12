/**
 * Entrypoint.
 *
 *   npm start        # research ACTIVE_PRODUCT from src/products.ts
 *
 * Prints a human-readable summary (incl. token usage + estimated API cost) and
 * writes the full validated JSON report to ./output.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { ACTIVE_PRODUCT } from "./products.js";
import type { FinalReport } from "./schema.js";
import { runResearch } from "./orchestrator.js";

async function main(): Promise<void> {
  const product = ACTIVE_PRODUCT;

  log.info("ReviewBridge — Product Review Intelligence Agent (PoC)");
  log.info("Provider: OpenAI");
  log.info(`Model: ${config.openaiModel}`);
  log.info(`Max sources: ${config.maxSources}`);
  log.info("Search strategy: OpenAI native web search");
  log.info(`Product: ${product.name} | SKU: ${product.sku ?? "-"} | model#: ${product.model ?? "-"}`);
  console.log();

  let report: FinalReport;
  try {
    report = await runResearch(product);
  } catch (err) {
    log.error(`research failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const path = await save(report);
  printSummary(report);
  console.log();
  log.info(`full JSON report: ${path}`);
}

async function save(report: FinalReport): Promise<string> {
  await mkdir(config.outputDir, { recursive: true });
  const slug = report.product.requested_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(config.outputDir, `${slug}-${stamp}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  return path;
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

void main();
