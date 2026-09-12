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

export const config = {
  openaiApiKey: str("OPENAI_API_KEY"),

  /**
   * Cost-conscious model that supports the Responses API web_search tool.
   * Override with OPENAI_MODEL (e.g. gpt-5.6-luna). Not hardcoded elsewhere.
   */
  openaiModel: str("OPENAI_MODEL", "gpt-4.1-mini"),

  /** After discovery, at most this many sources are collected/analysed. */
  maxSources: int("MAX_SOURCES", 5),

  /** Target number of deliberate, review-focused search queries (3–5). */
  searchQueryCount: Math.min(6, Math.max(3, int("SEARCH_QUERIES", 5))),

  /** Where the JSON report is written. */
  outputDir: "output",

  logLevel: str("LOG_LEVEL", "info"),
} as const;

export type Config = typeof config;
