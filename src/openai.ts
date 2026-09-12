/**
 * OpenAI client + the single structured-response helper used by every step.
 *
 * One `respond()` call == one OpenAI Responses API request. Usage is captured
 * from `response.usage` (never estimated) and web_search actions are logged.
 */
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod/v4";
import { config } from "./config.js";
import { log } from "./logger.js";
import { usage } from "./usage.js";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  client ??= new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

interface RespondOptions<T extends z.ZodTypeAny> {
  /** Short label for logs, e.g. "plan". */
  label: string;
  /** System-level instructions. */
  instructions: string;
  /** The user input / task. */
  input: string;
  /** Zod schema the reply must satisfy (OpenAI strict structured output + local re-validate). */
  schema: T;
  schemaName: string;
  /** Enable OpenAI's native web search tool for this call. */
  webSearch?: boolean;
  /** Cap on web-search tool calls (search / open_page / find_in_page) for this request. */
  maxToolCalls?: number;
  searchContextSize?: "low" | "medium" | "high";
  maxOutputTokens?: number;
}

export interface RespondResult<T> {
  data: T;
  webSearchCalls: number;
  searchQueries: string[];
  openedPages: string[];
}

export async function respond<T extends z.ZodTypeAny>(
  opts: RespondOptions<T>,
): Promise<RespondResult<z.infer<T>>> {
  const {
    label,
    instructions,
    input,
    schema,
    schemaName,
    webSearch = false,
    maxToolCalls,
    searchContextSize = "medium",
    maxOutputTokens = 8_000,
  } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = {
    model: config.openaiModel,
    instructions,
    input,
    text: { format: zodTextFormat(schema, schemaName) },
    max_output_tokens: maxOutputTokens,
  };
  if (webSearch) {
    req.tools = [{ type: "web_search", search_context_size: searchContextSize }];
    req.tool_choice = "auto";
    if (maxToolCalls != null) req.max_tool_calls = maxToolCalls;
    req.include = ["web_search_call.action.sources"];
  }

  let res;
  try {
    res = await getClient().responses.parse(req);
  } catch (err) {
    throw translateError(err, label);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output: any[] = res.output ?? [];
  const wsItems = output.filter((o) => o?.type === "web_search_call");
  const searchQueries: string[] = [];
  const openedPages: string[] = [];
  // Conservative billable count: one unit per query / open_page / find_in_page.
  // (OpenAI bills web search at $10/1k "calls"; a single web_search_call item can
  // carry several queries, so counting per action avoids under-estimating.)
  let billableSearchCalls = 0;
  for (const item of wsItems) {
    const action = item.action ?? {};
    if (action.type === "search") {
      const qs: string[] = action.queries ?? (action.query ? [action.query] : []);
      for (const q of qs) if (q) searchQueries.push(q);
      billableSearchCalls += Math.max(1, qs.filter(Boolean).length);
    } else if (action.type === "open_page") {
      if (action.url) openedPages.push(action.url);
      billableSearchCalls += 1;
    } else {
      billableSearchCalls += 1; // find_in_page or unknown
    }
  }

  usage.record(res.usage, billableSearchCalls);

  const u = res.usage;
  log.detail(
    `api [${label}]: ${u?.input_tokens ?? "?"} in` +
      (u?.input_tokens_details?.cached_tokens
        ? ` (${u.input_tokens_details.cached_tokens} cached)`
        : "") +
      ` / ${u?.output_tokens ?? "?"} out` +
      (u?.output_tokens_details?.reasoning_tokens
        ? ` (${u.output_tokens_details.reasoning_tokens} reasoning)`
        : "") +
      (billableSearchCalls ? ` | ${billableSearchCalls} web-search action(s)` : ""),
  );
  for (const q of searchQueries) log.detail(`  search: "${q}"`);
  for (const p of openedPages) log.detail(`  open_page: ${p}`);

  const parsed = res.output_parsed;
  if (parsed == null) {
    const reason = res.incomplete_details?.reason ?? res.status ?? "unknown";
    throw new Error(
      `[${label}] model did not return a valid ${schemaName} (status: ${reason}). ` +
        `text: ${String(res.output_text ?? "").slice(0, 200)}`,
    );
  }

  // Belt-and-braces: re-validate with the same schema.
  const check = schema.safeParse(parsed);
  if (!check.success) {
    throw new Error(
      `[${label}] ${schemaName} failed local validation: ${check.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    data: check.data,
    webSearchCalls: billableSearchCalls,
    searchQueries,
    openedPages,
  };
}

function translateError(err: unknown, label: string): Error {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const status = e?.status;
  const msg = e?.message ?? String(err);
  if (status === 401) return new Error(`OpenAI auth failed — check OPENAI_API_KEY. (${msg})`);
  if (status === 429) {
    return new Error(`OpenAI rate limit / quota hit during "${label}": ${msg}`);
  }
  if (status === 400 && /web_search|tool/i.test(msg)) {
    return new Error(
      `Model "${config.openaiModel}" rejected the web_search tool during "${label}": ${msg}. ` +
        "Set OPENAI_MODEL to one that supports Responses API web search (e.g. gpt-4.1-mini).",
    );
  }
  return new Error(`OpenAI request "${label}" failed${status ? ` (${status})` : ""}: ${msg}`);
}
