/**
 * Minimal leveled logger with progress-step helpers.
 *
 * Never prints environment variables or API keys. Any `sk-...` looking token
 * that slips into a log call is redacted defensively.
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

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${String(redact(msg))}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra !== undefined) stream(line, redact(extra));
  else stream(line);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),

  /** `[2/5] ...` style progress header. */
  step: (n: number, total: number, label: string) => emit("info", `[${n}/${total}] ${label}`),

  /** Indented sub-line under a step. */
  detail: (msg: string) => emit("info", `      ${msg}`),
};
