/**
 * Minimal leveled logger with progress-step helpers.
 *
 * Never prints environment variables or API keys. Any `sk-...` looking token
 * that slips into a log call is redacted defensively.
 *
 * Console output (stdout/stderr — visible in a local terminal or your hosting
 * platform's function/server logs) always gets EVERYTHING, at full detail.
 * The web UI's live log panel is fed by `onLogLine` subscribers and only gets
 * a curated subset — `step`/`info`/`warn`/`error`/`ui` — so a demo doesn't
 * drown in the full per-candidate/per-rejection diagnostic trail. Use
 * `log.detail()` for that verbose trail (console only) and `log.ui()` for the
 * handful of lines per phase that are worth a viewer watching live.
 */
import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level) in LEVELS ? (config.logLevel as Level) : "info"];

const KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}/g;

function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(KEY_PATTERN, "sk-***");
  return value;
}

/** Optional subscribers (e.g. the web server) that want a copy of curated log lines. */
type LineListener = (line: string) => void;
const listeners = new Set<LineListener>();

/** Subscribe to curated log lines as plain text. Returns an unsubscribe function. */
export function onLogLine(fn: LineListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(level: Level, msg: string, broadcast: boolean, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${String(redact(msg))}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra !== undefined) stream(line, redact(extra));
  else stream(line);
  if (broadcast && listeners.size) for (const fn of listeners) fn(line);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, false, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, true, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, true, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, true, extra),

  /** `[2/5] ...` style progress header. Always shown in the UI log panel. */
  step: (n: number, total: number, label: string) => emit("info", `[${n}/${total}] ${label}`, true),

  /** Verbose diagnostic sub-line (candidate dumps, rejections, etc). Console only. */
  detail: (msg: string) => emit("info", `      ${msg}`, false),

  /** Curated milestone sub-line — worth a demo viewer seeing live. Console + UI panel. */
  ui: (msg: string) => emit("info", `      ${msg}`, true),
};
