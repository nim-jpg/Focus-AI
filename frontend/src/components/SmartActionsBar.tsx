import { useState } from "react";
import type { Goal, Task } from "@/types/task";
import {
  applyLocationUpdates,
  type AutoSyncResult,
  type AutoSyncReviewItem,
} from "@/lib/googleCalendar";
import { runMatchAll, type AppliedMatch } from "@/lib/runMatchAll";

/**
 * Two consolidated action buttons that live in the app header — replaces
 * the half-dozen scattered AI / Google buttons (Re-rank Top 3, Match
 * tasks to goals, Refresh AI, Sync from Google, Reload events,
 * Auto-sync, Duplicate audit, etc.) with one click each.
 *
 *  AI       — runs the full categorisation pipeline:
 *                 1. Re-rank Top 3 (AI prioritisation)
 *                 2. Match tasks to goals (theme-bucket + AI matcher)
 *             Results land in the same caches the existing flows use,
 *             so the rest of the UI lights up without any extra work.
 *
 *  Google   — fetch + dedup + enrich, end-to-end. Reuses the existing
 *             auto-sync endpoint that imports events as tasks AND writes
 *             back enriched addresses to medium-confidence locations.
 *             Shows a tiny inline summary chip after each run.
 *
 * Both buttons surface their result inline (success counts, error
 * messages) so the user always knows what happened — no silent runs.
 */
interface Props {
  /** Full task + goal pool — needed for the Match flow. */
  tasks: Task[];
  goals: Goal[];
  /** Re-rank Top 3 (the existing handleAiRefresh from App.tsx). The
   *  AI button kicks this off as step 1 of the pipeline. */
  onAiRerank: () => Promise<void>;
  /** Idempotent goal-link — same handler the Goals tab uses. */
  onLinkTaskToGoal: (taskId: string, goalId: string) => void;
  /** End-to-end calendar sync — fetch events, dedup, enrich addresses,
   *  import as tasks. Returns the auto-sync result so this component
   *  can show what happened inline. */
  onAutoSync: () => Promise<AutoSyncResult>;
  /** Persist a Skip on a low-confidence enrichment proposal. */
  onSkipEvent: (eventId: string) => void;
  /** True when an AI rank round-trip is in flight (driven by App.tsx). */
  aiBusy?: boolean;
}

export function SmartActionsBar({
  tasks,
  goals,
  onAiRerank,
  onLinkTaskToGoal,
  onAutoSync,
  onSkipEvent,
  aiBusy = false,
}: Props) {
  const [aiResult, setAiResult] = useState<{
    rankDone: boolean;
    matched: AppliedMatch[];
    error?: string;
  } | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);

  const [syncResult, setSyncResult] = useState<AutoSyncResult | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const runAi = async () => {
    setMatchBusy(true);
    setAiResult(null);
    try {
      // Step 1 — re-rank Top 3. This is the existing handleAiRefresh
      // path; preserves the cache + incremental rank semantics.
      await onAiRerank();
      // Step 2 — keyword + AI goal matcher. Idempotent: tasks already
      // linked to a goal are skipped inside runMatchAll.
      const { applied, aiError } = await runMatchAll(
        tasks,
        goals,
        onLinkTaskToGoal,
      );
      setAiResult({ rankDone: true, matched: applied, error: aiError });
    } catch (err) {
      setAiResult({
        rankDone: false,
        matched: [],
        error: err instanceof Error ? err.message : "AI unavailable",
      });
    } finally {
      setMatchBusy(false);
    }
  };

  const runSync = async () => {
    setSyncBusy(true);
    setSyncError(null);
    try {
      const r = await onAutoSync();
      setSyncResult(r);
      setReviewOpen(r.enrichmentNeedsReview.length > 0);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "sync failed");
    } finally {
      setSyncBusy(false);
    }
  };

  const aiBusyState = aiBusy || matchBusy;
  const aiSummary = aiResult
    ? aiResult.error
      ? `AI: ${aiResult.error}`
      : aiResult.matched.length > 0
        ? `Linked ${aiResult.matched.length} task${aiResult.matched.length === 1 ? "" : "s"}`
        : aiResult.rankDone
          ? "Up to date"
          : null
    : null;

  const syncSummary = syncResult
    ? [
        syncResult.imported > 0
          ? `${syncResult.imported} task${syncResult.imported === 1 ? "" : "s"}`
          : null,
        syncResult.enrichedAuto > 0
          ? `${syncResult.enrichedAuto} address${syncResult.enrichedAuto === 1 ? "" : "es"}`
          : null,
        syncResult.enrichmentNeedsReview.length > 0
          ? `${syncResult.enrichmentNeedsReview.length} need${syncResult.enrichmentNeedsReview.length === 1 ? "s" : ""} review`
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || null
    : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
        AI
      </span>
      <button
        type="button"
        onClick={() => void runAi()}
        disabled={aiBusyState || tasks.length === 0}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-2.5 text-[11px] font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-60"
        title="Re-rank Top Three + match tasks to goals (theme + AI semantic match) in one go"
      >
        {aiBusyState ? "Running…" : "✨ Smart organise"}
      </button>
      {aiSummary && (
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            aiResult?.error
              ? "border-amber-300 bg-amber-50 text-amber-800"
              : "border-violet-300 bg-white text-violet-800"
          }`}
        >
          {aiSummary}
        </span>
      )}

      <span className="ml-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
        Google
      </span>
      <button
        type="button"
        onClick={() => void runSync()}
        disabled={syncBusy}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-60"
        title="Fetch calendar events, dedup, enrich addresses, import as tasks — end-to-end."
      >
        {syncBusy ? "Syncing…" : "🔄 Sync"}
      </button>
      {syncSummary && (
        <span className="rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[10px] font-medium text-emerald-800">
          {syncSummary}
        </span>
      )}
      {syncError && (
        <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-800">
          {syncError}
        </span>
      )}
      {syncResult && syncResult.enrichmentNeedsReview.length > 0 && (
        <button
          type="button"
          onClick={() => setReviewOpen((v) => !v)}
          className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
          title={
            reviewOpen
              ? "Collapse the review list"
              : "Approve / skip medium-confidence address proposals"
          }
        >
          {reviewOpen ? "Hide review" : "Review →"}
        </button>
      )}

      {/* Inline review panel — appears below the bar when there are
          medium / low-confidence address proposals to approve. */}
      {reviewOpen &&
        syncResult &&
        syncResult.enrichmentNeedsReview.length > 0 && (
          <ReviewList
            items={syncResult.enrichmentNeedsReview}
            onApprove={async (item) => {
              await applyLocationUpdates([
                {
                  id: item.id,
                  calendarId: item.calendarId,
                  location: item.proposedAddress ?? "",
                },
              ]);
              setSyncResult((prev) =>
                prev
                  ? {
                      ...prev,
                      enrichmentNeedsReview: prev.enrichmentNeedsReview.filter(
                        (x) => x.id !== item.id,
                      ),
                      enrichedAuto: prev.enrichedAuto + 1,
                    }
                  : prev,
              );
            }}
            onSkip={(item) => {
              onSkipEvent(item.id);
              setSyncResult((prev) =>
                prev
                  ? {
                      ...prev,
                      enrichmentNeedsReview: prev.enrichmentNeedsReview.filter(
                        (x) => x.id !== item.id,
                      ),
                    }
                  : prev,
              );
            }}
          />
        )}
    </div>
  );
}

function ReviewList({
  items,
  onApprove,
  onSkip,
}: {
  items: AutoSyncReviewItem[];
  onApprove: (item: AutoSyncReviewItem) => void;
  onSkip: (item: AutoSyncReviewItem) => void;
}) {
  return (
    <ul className="mt-2 w-full space-y-1.5">
      {items.map((it) => (
        <li
          key={it.id}
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5"
        >
          <div className="min-w-0 flex-1 text-[11px]">
            <div className="font-medium text-slate-900">{it.summary}</div>
            <div className="text-slate-600">
              <span className="text-slate-400">→</span>{" "}
              {it.proposedAddress ?? "(no proposal)"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onApprove(it)}
            className="flex-none rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100"
          >
            ✓ Apply
          </button>
          <button
            type="button"
            onClick={() => onSkip(it)}
            className="flex-none rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-500 hover:border-slate-400 hover:text-slate-700"
          >
            Skip
          </button>
        </li>
      ))}
    </ul>
  );
}
