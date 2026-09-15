/**
 * Environment configuration.
 *
 * Single AI provider: OpenAI (Responses API + native web search).
 * API keys are read from the environment only and are never logged.
 */
import "dotenv/config";

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

const maxSources = int("MAX_SOURCES", 5);

export const config = {
  openaiApiKey: str("OPENAI_API_KEY"),

  /**
   * Cost-conscious model that supports the Responses API web_search tool.
   * Override with OPENAI_MODEL (e.g. gpt-5.6-luna). Not hardcoded elsewhere.
   */
  openaiModel: str("OPENAI_MODEL", "gpt-4.1-mini"),

  /** After discovery, at most this many sources are collected/analysed. */
  maxSources,

  /** Target number of deliberate, review-focused search queries (3–5). */
  searchQueryCount: Math.min(6, Math.max(3, int("SEARCH_QUERIES", 5))),

  /** Where the JSON report is written. */
  outputDir: "output",

  // ---- Review Source Registry (data/review-source-registry.json) ----
  /** Persist + reuse validated review sources across runs, per product identity. */
  registryEnabled: bool("REGISTRY_ENABLED", true),
  /** JSON file the registry is stored in — plain fs, no DB. */
  registryPath: str("REGISTRY_PATH", "data/review-source-registry.json"),
  /** A trusted source older than this is re-verified before reuse, not reused blindly. */
  registryTtlHours: int("REGISTRY_TTL_HOURS", 168),
  /** Known sources must yield at least this many usable matches to skip web discovery. */
  registryMinSources: Math.max(1, Math.min(maxSources, int("REGISTRY_MIN_SOURCES", 2))),

  logLevel: str("LOG_LEVEL", "info"),

  /** Port for the web server (`npm run dev`). */
  port: int("PORT", 3000),
} as const;

export type Config = typeof config;
