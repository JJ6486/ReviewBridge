/**
 * Persists a FinalReport to OUTPUT_DIR as JSON. Shared by the CLI (`index.ts`)
 * and the web server (`server.ts`) so both write reports the same way.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import type { FinalReport } from "./schema.js";

export async function saveReport(report: FinalReport): Promise<string> {
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
