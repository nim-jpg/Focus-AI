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
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-gradient-to-r from-emerald-50 to-emerald-50/40 px-3 py-2 text-xs">
      <button
        type="button"
        className="btn-primary text-xs"
        onClick={run}
        disabled={busy}
      >
        {busy ? "Syncing…" : "Sync from Google"}
      </button>
      <span className="text-slate-600">
        Pulls actionable events as tasks and writes back fuller addresses.
        AI rank is a separate button — this one is uncapped.
      </span>
      {summary && (
        <span className="ml-auto rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-800">
          {summary || "Nothing new"}
        </span>
      )}
      {result && !summary && (
        <span className="ml-auto text-[11px] text-slate-500">
          Up to date — nothing new in the next 14 days.
        </span>
      )}
      {error && (
        <span className="ml-auto rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-800">
          {error}
        </span>
      )}
    </div>
  );
}
