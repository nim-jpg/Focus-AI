import { useState } from "react";
import type { Goal, PrioritizedTask } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  prioritized: PrioritizedTask[];
  onComplete: (id: string) => void;
  onSchedule: (id: string) => void;
  onSnooze: (id: string, untilIso: string) => void;
  goals?: Goal[];
  calendarConnected?: boolean;
  /** Click-handler for a goal chip — opens the goal in the Goals tab. */
  onOpenGoal?: (goalId: string) => void;
}

/**
 * One-or-two-word label for a goal chip. The full title only shows on hover
 * via `title=`. Strategy:
 *  1. Drop common filler ("get", "to", "the", "a", "my", "more"…)
 *  2. Pick the first remaining noun-ish word; if that word is short (<5 chars)
 *     keep the second word too so the chip reads as a phrase.
 *  3. Cap at 16 chars without ellipsis — short enough for a single chip but
 *     no truncation noise.
 */
function shortGoalLabel(title: string): string {
  const filler = new Set([
    "get",
    "to",
    "a",
    "an",
    "the",
    "my",
    "be",
    "more",
    "less",
    "of",
    "for",
    "with",
    "and",
    "or",
    "in",
    "on",
    "at",
    "by",
    "from",
    "into",
    "make",
    "do",
    "have",
    "build",
    "become",
  ]);
  const words = title
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\w\-]/g, ""))
    .filter((w) => w.length > 0);
  const meaningful = words.filter((w) => !filler.has(w.toLowerCase()));
  if (meaningful.length === 0) {
    // All filler? Fall back to the original first word.
    return (words[0] ?? title).slice(0, 16);
  }
  const first = meaningful[0];
  // If the lead word is short, attach the second meaningful word so the chip
  // reads as a phrase ("home gym", "side project") rather than a fragment
  // ("home", "side").
  if (first.length < 5 && meaningful[1]) {
    const phrase = `${first} ${meaningful[1]}`;
    if (phrase.length <= 16) return phrase.toLowerCase();
  }
  return first.toLowerCase().slice(0, 16);
}

const SNOOZE_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
  { label: "1 month", days: 30 },
];

const TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Now",
  2: "Soon",
  3: "Balance",
  4: "Later",
};

// Tier visuals: flat surface + tier-coloured left edge. Used to lean on a
// pastel gradient (from-rose-50 via-white to-rose-50/30) but Tailwind's
// gradient stops don't dark-override cleanly — `via-white` injected white
// into the middle of every card and titles disappeared in dark mode.
// Flat surface + the inset-stripe accent (TIER_ACCENTS below) gives the
// same scannability in both light AND dark; closer to Spotify / Revolut
// in feel than the prior pastel-tinted look.
const TIER_CLASSES: Record<1 | 2 | 3 | 4, string> = {
  1: "border-slate-200/70 bg-white",
  2: "border-slate-200/70 bg-white",
  3: "border-slate-200/70 bg-white",
  4: "border-slate-200/70 bg-white",
};

const TIER_ACCENTS: Record<1 | 2 | 3 | 4, string> = {
  1: "shadow-[inset_4px_0_0_0_rgb(244_63_94)]",
  2: "shadow-[inset_4px_0_0_0_rgb(14_165_233)]",
  3: "shadow-[inset_4px_0_0_0_rgb(139_92_246)]",
  4: "shadow-[inset_4px_0_0_0_rgb(100_116_139)]",
};

// Compact tier-numbered chip — replaces the larger white circle while
// keeping the tier colour visible without explicit text.
const TIER_NUMBER_CLASSES: Record<1 | 2 | 3 | 4, string> = {
  1: "bg-rose-600 text-white",
  2: "bg-sky-600 text-white",
  3: "bg-violet-600 text-white",
  4: "bg-slate-600 text-white",
};

export function TopThree({
  prioritized,
  onComplete,
  onSchedule,
  onSnooze,
  goals = [],
  calendarConnected = false,
  onOpenGoal,
}: Props) {
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const [snoozeOpenFor, setSnoozeOpenFor] = useState<string | null>(null);
  if (prioritized.length === 0) {
    return (
      <div className="card text-center text-sm text-slate-500">
        Nothing surfaced yet — add a few tasks and we&apos;ll find your three.
      </div>
    );
  }

  return (
    <ol className="space-y-2">
      {prioritized.map(({ task, tier, reasoning }, idx) => (
        <li
          key={task.id}
          className={`rounded-lg border px-3 py-2 shadow-sm transition-all hover:shadow-md ${TIER_CLASSES[tier]} ${TIER_ACCENTS[tier]}`}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex min-w-0 items-center gap-2 sm:flex-1">
              {/* Tier number replaces the 8x8 white badge — tier-coloured
                  small chip carries the same info in a third the space. */}
              <span
                className={`flex h-6 w-6 flex-none items-center justify-center rounded-md text-xs font-semibold ${TIER_NUMBER_CLASSES[tier]}`}
                title={`Tier ${tier} · ${TIER_LABELS[tier]}`}
              >
                {idx + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="truncate text-sm font-semibold text-slate-900">
                    {task.title}
                  </h3>
                  <ThemeBadge theme={task.theme} />
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">
                  {reasoning}
                </p>
                {/* Meta row: only what changes the user's decision —
                    duration, due date, goal links. Inline, single line,
                    truncates instead of wrapping. */}
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                  <span>{task.estimatedMinutes ?? 30}m</span>
                  {task.dueDate && (
                    <>
                      <span aria-hidden>·</span>
                      <span>
                        due{" "}
                        {new Date(task.dueDate).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </>
                  )}
                  {(task.goalIds ?? []).length > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      {(task.goalIds ?? [])
                        .map((id) => goalById.get(id))
                        .filter((g): g is NonNullable<typeof g> => Boolean(g))
                        .slice(0, 2)
                        .map((g) => {
                          const short = shortGoalLabel(g.title);
                          const className =
                            "rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-800 hover:border-emerald-500";
                          return onOpenGoal ? (
                            <button
                              key={g.id}
                              type="button"
                              onClick={() => onOpenGoal(g.id)}
                              className={`${className} cursor-pointer`}
                              title={`${g.title} — click to open in Goals`}
                            >
                              {short}
                            </button>
                          ) : (
                            <span key={g.id} className={className} title={g.title}>
                              {short}
                            </span>
                          );
                        })}
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-row flex-wrap items-center gap-1.5 sm:flex-none">
              <button
                type="button"
                className="btn-secondary !min-h-[32px] !px-2.5 !py-1 text-xs"
                onClick={() => onSchedule(task.id)}
                title={
                  !calendarConnected
                    ? "Connect Google Calendar in the header to enable"
                    : task.calendarEventId
                    ? "Already scheduled — click to re-schedule"
                    : "Schedule on Google Calendar"
                }
              >
                {task.calendarEventId ? "Re-sched" : "Schedule"}
              </button>
              <button
                type="button"
                className="btn-primary !min-h-[32px] !px-2.5 !py-1 text-xs"
                onClick={() => onComplete(task.id)}
              >
                Done
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="text-xs text-slate-500 hover:text-slate-900"
                  onClick={() =>
                    setSnoozeOpenFor((id) => (id === task.id ? null : task.id))
                  }
                  title="Hide until later — useful when blocked externally"
                >
                  Snooze ▾
                </button>
                {snoozeOpenFor === task.id && (
                  <div className="absolute left-0 right-auto z-20 mt-1 w-32 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg sm:left-auto sm:right-0">
                    {SNOOZE_OPTIONS.map((opt) => (
                      <button
                        key={opt.days}
                        type="button"
                        className="block w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          const until = new Date();
                          until.setDate(until.getDate() + opt.days);
                          onSnooze(task.id, until.toISOString());
                          setSnoozeOpenFor(null);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
