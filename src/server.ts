/**
 * Web UI server — for demoing the pipeline without the CLI.
 *
 *   npm run dev
 *
 * Serves the single-page frontend (public/index.html) and a tiny JSON API on
 * top of the exact same `runBatch`/`runResearch` pipeline the CLI uses. No
 * framework, no build step, no new dependency — just `node:http`.
 *
 * Jobs run one at a time (in-memory, PoC-friendly): this process holds at most
 * one batch in flight, which keeps the shared `usage` tracker and the log
 * subscriber below unambiguous. A second submit while one is running gets a
 * 409 telling the caller to wait.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { config } from "./config.js";
import { log, onLogLine } from "./logger.js";
import type { ProductInput } from "./products.js";
import type { FinalReport } from "./schema.js";
import { runBatch, type BatchEntry } from "./batchRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, "..", "public", "index.html");

/* ---------------- job state (single job at a time) ---------------- */

type JobStatus = "running" | "done" | "error";

interface ProductResult {
  requested_name: string;
  sku: string | null;
  status: "SUCCESS_LIKE" | "ERROR";
  report: FinalReport | null;
  error: string | null;
}

interface Job {
  id: string;
  status: JobStatus;
  total: number;
  completedIndex: number; // how many products have finished
  currentProduct: string | null;
  logLines: string[];
  results: ProductResult[];
  startedAt: string;
  finishedAt: string | null;
  fatalError: string | null;
}

let currentJob: Job | null = null;

const RequestProduct = z.object({
  name: z.string().trim().min(1, "Product name is required."),
  sku: z.string().trim().nullable(),
});
const ResearchRequest = z.object({
  products: z.array(RequestProduct).min(2, "At least 2 products are required."),
});

async function startJob(products: ProductInput[]): Promise<Job> {
  const job: Job = {
    id: randomUUID(),
    status: "running",
    total: products.length,
    completedIndex: 0,
    currentProduct: products[0]?.name ?? null,
    logLines: [],
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    fatalError: null,
  };
  currentJob = job;

  const unsubscribe = onLogLine((line) => {
    job.logLines.push(line);
    if (job.logLines.length > 2000) job.logLines.splice(0, job.logLines.length - 2000);
  });

  // Run in the background — the HTTP handler returns immediately with the job id.
  void (async () => {
    try {
      const batch = await runBatch(products, (p) => {
        job.completedIndex = p.index;
        job.currentProduct = p.product.name;
      });
      job.results = batch.map(toProductResult);
      job.completedIndex = products.length;
      job.status = "done";
    } catch (err) {
      job.fatalError = (err as Error).message;
      job.status = "error";
    } finally {
      job.currentProduct = null;
      job.finishedAt = new Date().toISOString();
      unsubscribe();
    }
  })();

  return job;
}

function toProductResult(b: BatchEntry): ProductResult {
  return {
    requested_name: b.product.name,
    sku: b.product.sku,
    status: b.report ? "SUCCESS_LIKE" : "ERROR",
    report: b.report,
    error: b.error,
  };
}

/* ---------------- HTTP plumbing ---------------- */

async function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function jobPublicView(job: Job): unknown {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completedIndex: job.completedIndex,
    currentProduct: job.currentProduct,
    logLines: job.logLines,
    results: job.results,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    fatalError: job.fatalError,
  };
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    log.error(`web server error: ${(err as Error).message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error." });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(INDEX_HTML, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/research") {
    if (currentJob?.status === "running") {
      sendJson(res, 409, { error: "A research batch is already running. Wait for it to finish." });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: `Invalid request body: ${(err as Error).message}` });
      return;
    }

    const parsed = ResearchRequest.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }

    const products: ProductInput[] = parsed.data.products.map((p) => ({
      name: p.name,
      sku: p.sku && p.sku.length > 0 ? p.sku : null,
      model: null,
    }));

    const job = await startJob(products);
    sendJson(res, 202, { jobId: job.id });
    return;
  }

  const jobMatch = /^\/api\/research\/([a-f0-9-]+)$/i.exec(url.pathname);
  if (req.method === "GET" && jobMatch) {
    const id = jobMatch[1];
    if (!currentJob || currentJob.id !== id) {
      sendJson(res, 404, { error: "Unknown job id." });
      return;
    }
    sendJson(res, 200, jobPublicView(currentJob));
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

server.listen(config.port, () => {
  log.info(`ReviewBridge web UI: http://localhost:${config.port}`);
  log.info(`Model: ${config.openaiModel} | Max sources: ${config.maxSources} | Registry: ${config.registryEnabled ? "on" : "off"}`);
});
