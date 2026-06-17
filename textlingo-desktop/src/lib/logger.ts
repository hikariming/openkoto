import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend logger that mirrors to the console AND forwards to the Rust global
 * log store (Settings → Logs), so frontend, Rust, and Python logs share one
 * timeline. Forwarding is fire-and-forget — logging must never break the UI.
 *
 * Use `source: "pdf"` for PDF-translation logs so they interleave with the
 * Rust/Python pipeline trace under the same source filter.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function format(args: unknown[]): string {
  return args.map(stringify).join(" ");
}

function emit(level: LogLevel, source: string, args: unknown[]): void {
  const message = format(args);
  const line = `[${source}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  // Forward to the backend store; swallow errors (e.g. running outside Tauri).
  void invoke("append_log_cmd", { level, source, message }).catch(() => {});
}

export const logger = {
  debug: (source: string, ...args: unknown[]) => emit("debug", source, args),
  info: (source: string, ...args: unknown[]) => emit("info", source, args),
  warn: (source: string, ...args: unknown[]) => emit("warn", source, args),
  error: (source: string, ...args: unknown[]) => emit("error", source, args),
};
