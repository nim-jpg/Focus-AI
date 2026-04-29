import { useState } from "react";
import type { AutoSyncResult } from "@/lib/googleCalendar";

interface Props {
  /** Runs auto-sync + AI re-rank end-to-end. Returns the auto-sync result
   *  card data so this component can show the inline summary. */
  onAutoSync: () => Promise<AutoSyncResult>;
}

/**
 * Single button that consolidates the calendar scan / pull-as-tasks /
 * location-enrich / AI re-rank flow. Lives above the schedule view.
 *
 * Replaces the four-panel Settings layout that used to scatter these
 * actions across multiple manual flows. The duplicate audit stays in
 * Settings because that's destructive cleanup, not routine sync.
 */
export function SyncFromGoogleButton({ onAutoSync }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AutoSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await onAutoSync();
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally {
      setBusy(false);
    }
  };

  // Compact one-liner result so the schedule above doesn't get pushed off
  // screen by a verbose card. Detailed needs-review list is intentionally
  // omitted here — that lives in Settings's manual enrich panel for users
  // who want to triage low-confidence proposals.
  const summary = result
    ? [
        result.imported > 0 ? `${result.imported} task${result.imported === 1 ? "" : "s"}` : null,
        result.enrichedAuto > 0
          ? `${result.enrichedAuto} address${result.enrichedAuto === 1 ? "" : "es"}`
          : null,
        result.enrichmentNeedsReview.length > 0
          ? `${result.enrichmentNeedsReview.length} need${result.enrichmentNeedsReview.length === 1 ? "s" : ""} review`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
      <button
        type="button"
        className="inline-flex h-7 items-center rounded-md border border-emerald-300 bg-emerald-50 px-2.5 text-[11px] font-medium text-emerald-800 transition-colors hover:bg-emerald-100 disabled:opacity-60"
        onClick={run}
        disabled={busy}
      >
        {busy ? "Syncing…" : "Sync from Google"}
      </button>
      {summary && (
        <span className="rounded-full border border-emerald-300 bg-white px-2 py-0.5 font-medium text-emerald-800">
          {summary}
        </span>
      )}
      {result && !summary && (
        <span>Up to date.</span>
      )}
      {error && (
        <span className="rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-800">
          {error}
        </span>
      )}
      {!result && !error && !busy && (
        <span className="text-slate-400">
          Pulls events as tasks and writes back addresses.
        </span>
      )}
    </div>
  );
}
