import { useEffect, useState } from "react";
import {
  applyLocationUpdates,
  type AutoSyncResult,
  type AutoSyncReviewItem,
} from "@/lib/googleCalendar";

interface Props {
  /** Runs auto-sync end-to-end. Returns the auto-sync result so this
   *  component can show the inline summary + review list. */
  onAutoSync: () => Promise<AutoSyncResult>;
  /** Persist a Skip — event id added to prefs.enrichmentSkippedEventIds
   *  so the next sync won't surface this event for review again. */
  onSkipEvent: (eventId: string) => void;
}

/**
 * Single button that consolidates the calendar scan / pull-as-tasks /
 * location-enrich flow. Lives above the schedule view. Shows an inline
 * review list for medium/low-confidence location proposals — the user
 * approves each one before anything is written to Google.
 */
export function SyncFromGoogleButton({ onAutoSync, onSkipEvent }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AutoSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await onAutoSync();
      setResult(r);
      setReviewOpen(r.enrichmentNeedsReview.length > 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally {
      setBusy(false);
    }
  };

  const summary = result
    ? [
        result.imported > 0
          ? `${result.imported} task${result.imported === 1 ? "" : "s"}`
          : null,
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
    <div className="space-y-2">
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
        {result && result.enrichmentNeedsReview.length > 0 && (
          <button
            type="button"
            onClick={() => setReviewOpen((v) => !v)}
            className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
          >
            {reviewOpen ? "Hide review" : "Review proposals →"}
          </button>
        )}
        {result && !summary && <span>Up to date.</span>}
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

      {result && reviewOpen && result.enrichmentNeedsReview.length > 0 && (
        <ReviewList
          items={result.enrichmentNeedsReview}
          onSkipEvent={onSkipEvent}
          onAllResolved={() => {
            setResult((prev) =>
              prev ? { ...prev, enrichmentNeedsReview: [] } : prev,
            );
            setReviewOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Inline review for medium/low-confidence location proposals. Each row
 * lets the user edit the address, open Google Maps for verification, then
 * apply (PATCH the Google event) or skip (drop from the local list).
 */
function ReviewList({
  items,
  onSkipEvent,
  onAllResolved,
}: {
  items: AutoSyncReviewItem[];
  onSkipEvent: (eventId: string) => void;
  onAllResolved: () => void;
}) {
  // Local mutable copy — we mutate as user resolves rows.
  const [pending, setPending] = useState<AutoSyncReviewItem[]>(items);
  // Per-row draft of the address text, seeded with Claude's proposal.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const it of items) out[it.id] = it.proposedAddress ?? "";
    return out;
  });
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});

  // If the parent passes a brand-new list, reset.
  useEffect(() => {
    setPending(items);
    const next: Record<string, string> = {};
    for (const it of items) next[it.id] = it.proposedAddress ?? "";
    setDrafts(next);
    setRowMsg({});
  }, [items]);

  useEffect(() => {
    if (pending.length === 0 && items.length > 0) onAllResolved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);

  const apply = async (it: AutoSyncReviewItem) => {
    const addr = (drafts[it.id] ?? "").trim();
    if (!addr) return;
    setBusyRow(it.id);
    try {
      const r = await applyLocationUpdates([
        { id: it.id, calendarId: it.calendarId, location: addr },
      ]);
      if (r.updated > 0) {
        setPending((prev) => prev.filter((p) => p.id !== it.id));
      } else {
        const failure = r.failures[0];
        setRowMsg((m) => ({
          ...m,
          [it.id]: failure?.reason ?? "update failed",
        }));
      }
    } catch (err) {
      setRowMsg((m) => ({
        ...m,
        [it.id]: err instanceof Error ? err.message : "apply failed",
      }));
    } finally {
      setBusyRow(null);
    }
  };

  const skip = (id: string) => {
    onSkipEvent(id);
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  if (pending.length === 0) return null;

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/40 p-2">
      <p className="text-[11px] text-amber-900">
        {pending.length} proposed location{pending.length === 1 ? "" : "s"} —
        review and apply, or skip. Nothing is written to Google until you click
        Apply on a row.
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {pending.map((it) => {
          const addr = drafts[it.id] ?? "";
          const msg = rowMsg[it.id];
          return (
            <li
              key={it.id}
              className="rounded border border-amber-200 bg-white p-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <div className="min-w-0">
                  <div className="font-medium text-slate-800">{it.summary}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                    <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0">
                      {it.calendarName}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0 text-white ${
                        it.confidence === "medium"
                          ? "bg-amber-600"
                          : "bg-slate-500"
                      }`}
                    >
                      {it.confidence}
                    </span>
                  </div>
                </div>
                <a
                  href={`https://www.google.com/maps/search/${encodeURIComponent(`${it.summary} ${it.currentLocation || ""}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-slate-500 hover:text-slate-900 hover:underline"
                >
                  look up on Maps ↗
                </a>
              </div>
              <div className="mt-1.5">
                <input
                  type="text"
                  className="input text-xs"
                  placeholder={
                    it.proposedAddress
                      ? it.proposedAddress
                      : "Type the real address (or paste from Maps)"
                  }
                  value={addr}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [it.id]: e.target.value }))
                  }
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                  onClick={() => void apply(it)}
                  disabled={busyRow === it.id || addr.trim().length === 0}
                >
                  {busyRow === it.id ? "Applying…" : "Apply"}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-400"
                  onClick={() => skip(it.id)}
                >
                  Skip
                </button>
                {msg && (
                  <span className="text-[11px] text-rose-700">{msg}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
