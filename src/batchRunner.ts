/**
 * Runs the pipeline once per product, in order. Shared by the CLI (`index.ts`)
 * and the web server (`server.ts`) so both batches behave identically: one
 * product's failure is recorded and never stops the rest of the batch.
 */
import { log } from "./logger.js";
import type { ProductInput } from "./products.js";
import type { FinalReport } from "./schema.js";
import { runResearch } from "./orchestrator.js";
import { saveReport } from "./reportStore.js";

export interface BatchEntry {
  product: ProductInput;
  report: FinalReport | null;
  path: string | null;
  error: string | null;
}

export interface BatchProgress {
  index: number; // 0-based
  total: number;
  product: ProductInput;
}

export async function runBatch(
  products: ProductInput[],
  onProgress?: (p: BatchProgress) => void,
): Promise<BatchEntry[]> {
  const batch: BatchEntry[] = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i]!;
    onProgress?.({ index: i, total: products.length, product });

    log.info(`═══ Product ${i + 1}/${products.length}: ${product.name} ═══`);
    log.info(`SKU: ${product.sku ?? "-"} | model#: ${product.model ?? "-"}`);

    let report: FinalReport | null = null;
    let path: string | null = null;
    let error: string | null = null;
    try {
      report = await runResearch(product);
      path = await saveReport(report);
      log.info(`full JSON report: ${path}`);
    } catch (err) {
      error = (err as Error).message;
      log.error(`research failed for "${product.name}": ${error}`);
    }

    batch.push({ product, report, path, error });
  }

  return batch;
}
