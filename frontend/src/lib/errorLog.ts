/**
 * Tiny no-SDK error reporter. Captures uncaught errors and unhandled
 * promise rejections, plus anything passed via reportError(), and stores
 * the most recent 50 in localStorage. Settings → Recent errors lets the
 * user see what went wrong and clear the log.
 *
 * Used as a Sentry-lite for solo dev / a small tester pool. Drop in
 * a real Sentry SDK if the user count grows.
 */

const KEY = "focus3:errorLog:v1";
const MAX_ENTRIES = 50;

export interface ErrorEntry {
  ts: number;
  source: "uncaught" | "unhandled-rejection" | "manual";
  message: string;
  stack?: string;
  context?: string;
  url?: string;
}

let installed = false;

function load(): ErrorEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ErrorEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: ErrorEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota or private mode — drop silently */
  }
}

function push(entry: ErrorEntry): void {
  const next = [entry, ...load()].slice(0, MAX_ENTRIES);
  save(next);
}

export function getErrorLog(): ErrorEntry[] {
  return load();
}

export function clearErrorLog(): void {
  save([]);
}

export function reportError(err: unknown, context?: string): void {
  const e =
    err instanceof Error ? err : new Error(String(err ?? "unknown error"));
  push({
    ts: Date.now(),
    source: "manual",
    message: e.message,
    stack: e.stack?.slice(0, 2000),
    context,
    url: typeof window !== "undefined" ? window.location.href : undefined,
  });
}

export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    push({
      ts: Date.now(),
      source: "uncaught",
      message: ev.message || String(ev.error?.message ?? ev.error ?? "Error"),
      stack: ev.error?.stack?.slice(0, 2000),
      url: window.location.href,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason as unknown;
    const err =
      reason instanceof Error ? reason : new Error(String(reason ?? "rejection"));
    push({
      ts: Date.now(),
      source: "unhandled-rejection",
      message: err.message,
      stack: err.stack?.slice(0, 2000),
      url: window.location.href,
    });
  });
}
