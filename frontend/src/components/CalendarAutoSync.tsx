import { useState } from "react";
import { runAutoSync, type AutoSyncResult } from "@/lib/googleCalendar";

interface Props {
  /** Called after a successful auto-sync so the parent can re-pull tasks
   *  from the backend (newly-imported tasks live in Supabase, not localStorage,
   *  until the cache-first sync grabs them). */
  onSyncComplete?: () => void;
}

/**
 * One-click sync from Google Calendar:
 *  - imports task-like events as Focus3 tasks (Claude classifies which events
 *    represent actionable work vs passive meetings)
 *  - auto-applies HIGH confidence location enrichments to the calendar
 *  - returns medium/low confidence enrichments for manual review (the
 *    existing "Enrich event locations" panel handles those)
 *
 * Auto-apply trust: only fires when the user explicitly clicks Sync now.
 * Heuristic safety on top — recurring events and >4h blocks are not
 * imported, low-confidence location proposals are never auto-written.
 */
export function CalendarAutoSync({ onSyncComplete }: Props) {
  const [result, setResult] = useState<AutoSyncResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await runAutoSync(14);
      setResult(r);
      onSyncComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary text-xs"
          onClick={run}
          disabled={loading}
        >
          {loading ? "Scanning + classifying…" : "Sync now (next 14 days)"}
        </button>
        <span className="text-[11px] text-slate-500">
          One round-trip — Claude decides what's actionable + writes addresses
          back. Recurring meetings + long blocks skipped automatically.
        </span>
      </div>

      {error && (
        <p className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border border-slate-200 bg-white p-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                Scanned
              </div>
              <div className="text-base font-semibold">
                {result.scanned}
                <span className="ml-1 text-[10px] font-normal text-slate-500">
                  events
                </span>
              </div>
              <div className="text-[10px] text-slate-500">
                across {result.calendars} calendar{result.calendars === 1 ? "" : "s"}
              </div>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2">
              <div className="text-[10px] uppercase tracking-wide text-emerald-700">
                Imported
              </div>
              <div className="text-base font-semibold text-emerald-900">
                {result.imported}
              </div>
              <div className="text-[10px] text-emerald-700">new tasks</div>
            </div>
            <div className="rounded-md border border-violet-200 bg-violet-50 p-2">
              <div className="text-[10px] uppercase tracking-wide text-violet-700">
                Addresses
              </div>
              <div className="text-base font-semibold text-violet-900">
                {result.enrichedAuto}
              </div>
              <div className="text-[10px] text-violet-700">auto-applied</div>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
              <div className="text-[10px] uppercase tracking-wide text-amber-700">
                Needs review
              </div>
              <div className="text-base font-semibold text-amber-900">
                {result.enrichmentNeedsReview.length}
              </div>
              <div className="text-[10px] text-amber-700">
                medium/low confidence
              </div>
            </div>
          </div>

          {result.enrichmentNeedsReview.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50/50 p-2">
              <p className="text-xs font-medium text-amber-900">
                {result.enrichmentNeedsReview.length} location
                {result.enrichmentNeedsReview.length === 1 ? "" : "s"} need a
                human eye
              </p>
              <p className="mt-0.5 text-[11px] text-amber-800">
                These weren't auto-applied because Claude wasn't confident. Use
                the "Enrich event locations" panel below to review and approve
                each one — same scan + apply flow, just manual.
              </p>
              <ul className="mt-1.5 space-y-1">
                {result.enrichmentNeedsReview.slice(0, 5).map((it) => (
                  <li
                    key={it.id}
                    className="rounded border border-amber-200 bg-white px-2 py-1 text-[11px]"
                  >
                    <span className="font-medium text-slate-800">
                      {it.summary}
                    </span>
                    <span className="ml-1 text-slate-500">
                      · {it.calendarName}
                    </span>
                    <div className="text-slate-600">
                      "{it.currentLocation}" →{" "}
                      <span className="italic">
                        {it.proposedAddress ?? "(no proposal)"}
                      </span>
                      <span className="ml-1 rounded bg-amber-200 px-1 text-[9px] uppercase tracking-wide text-amber-900">
                        {it.confidence}
                      </span>
                    </div>
                  </li>
                ))}
                {result.enrichmentNeedsReview.length > 5 && (
                  <li className="text-[11px] italic text-amber-700">
                    + {result.enrichmentNeedsReview.length - 5} more
                  </li>
                )}
              </ul>
            </div>
          )}

          {result.imported === 0 &&
            result.enrichedAuto === 0 &&
            result.enrichmentNeedsReview.length === 0 && (
              <p className="text-xs text-slate-500">
                Everything in the next 14 days is either already linked to a
                Focus3 task, a passive meeting, or has a complete address.
                Nothing to sync.
              </p>
            )}
        </div>
      )}
    </div>
  );
}
