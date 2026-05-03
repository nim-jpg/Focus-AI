import { useMemo } from "react";
import type { Goal, Task, MacroTheme } from "@/types/task";
import { MACRO_THEME_LABELS } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";
import { inferMacroThemes, pickGoalForTask } from "@/lib/themeRouter";

/**
 * "Unmapped tasks" panel — surfaces every open task that isn't linked
 * to any goal, classified by its inferred macro-themes (admin / events /
 * stress / learning / etc.). Even when there's no goal home to suggest,
 * the user gets:
 *
 *  - a complete list of unbucketed work
 *  - the macro-theme labels each task carries (so an admin deadline
 *    doubling as stress is visible at a glance)
 *  - one-click goal-link IF a plausible goal target exists for that
 *    macro-theme.
 *
 * Different from `SuggestedGoalLinks`:
 *  - SuggestedGoalLinks ONLY shows tasks that have a clear goal target
 *    — drives the bulk-link flow.
 *  - UnmappedTasks shows EVERY unlinked task, including those without
 *    a plausible goal yet — drives "what am I not tracking".
 *
 * Calendar appointments stay out of the goal-matching loop (already
 * known), but DO appear here under the "events" label so the user can
 * see all upcoming external commitments at once.
 */
interface Props {
  tasks: Task[];
  goals: Goal[];
  /** Persisted dismissals (re-uses the same prefs key as
   *  SuggestedGoalLinks so a dismissal there hides the row here too). */
  dismissedTaskIds: string[];
  onLink: (taskId: string, goalId: string) => void;
  onDismiss: (taskId: string) => void;
}

export function UnmappedTasks({
  tasks,
  goals,
  dismissedTaskIds,
  onLink,
  onDismiss,
}: Props) {
  const dismissed = useMemo(
    () => new Set(dismissedTaskIds),
    [dismissedTaskIds],
  );

  // Build a list of unmapped tasks with their inferred macro-themes
  // and a possible goal target (null if no goal of the matching macro
  // exists).
  const rows = useMemo(() => {
    const out: Array<{
      task: Task;
      macros: MacroTheme[];
      goal: Goal | null;
    }> = [];
    for (const task of tasks) {
      if (task.status === "completed") continue;
      if ((task.goalIds ?? []).length > 0) continue; // already linked
      if (dismissed.has(task.id)) continue;
      if (
        task.snoozedUntil &&
        new Date(task.snoozedUntil).getTime() > Date.now()
      ) {
        continue;
      }
      const macros = inferMacroThemes(task);
      // Calendar-derived tasks always carry the "events" macro; skip
      // them only if they have NO macros at all (rare).
      if (macros.length === 0 && !task.calendarEventId) continue;
      const goal = task.calendarEventId
        ? null // events stay out of goal buckets
        : pickGoalForTask(task, goals);
      out.push({ task, macros, goal });
    }
    // Group with a stable order: tasks with a goal target first
    // (they're one click away from being bucketed), then events,
    // then everything else.
    out.sort((a, b) => {
      const ag = a.goal ? 0 : a.task.calendarEventId ? 2 : 1;
      const bg = b.goal ? 0 : b.task.calendarEventId ? 2 : 1;
      return ag - bg;
    });
    return out;
  }, [tasks, goals, dismissed]);

  if (rows.length === 0) return null;

  // Quick stats for the header — shows the user the breakdown by
  // macro-theme without scanning the whole list.
  const stats = new Map<MacroTheme, number>();
  for (const r of rows) {
    for (const m of r.macros) {
      stats.set(m, (stats.get(m) ?? 0) + 1);
    }
  }
  const statSummary = Array.from(stats.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([m, n]) => `${MACRO_THEME_LABELS[m]} ${n}`)
    .join(" · ");

  return (
    <div className="card mb-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">
          Unmapped to goals · {rows.length}
        </h3>
        <span className="text-[11px] text-slate-500">{statSummary}</span>
      </div>
      <ul className="space-y-1.5">
        {rows.map(({ task, macros, goal }) => (
          <li
            key={task.id}
            className="flex items-center gap-2 rounded-md border border-slate-200/70 bg-white px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium text-slate-900">
                  {task.title}
                </span>
                <ThemeBadge theme={task.theme} />
                {macros.map((m) => (
                  <span
                    key={m}
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      m === "stress"
                        ? "bg-rose-100 text-rose-800"
                        : m === "admin"
                          ? "bg-amber-100 text-amber-800"
                          : m === "events"
                            ? "bg-sky-100 text-sky-800"
                            : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {MACRO_THEME_LABELS[m]}
                  </span>
                ))}
              </div>
              {goal && (
                <div className="text-[11px] text-slate-500">
                  <span className="text-slate-400">→ goal target:</span>{" "}
                  <span className="font-medium text-slate-700">
                    {goal.title}
                  </span>
                </div>
              )}
              {!goal && !task.calendarEventId && (
                <div className="text-[11px] italic text-slate-400">
                  no matching goal yet — add a goal to bucket this
                </div>
              )}
              {task.calendarEventId && (
                <div className="text-[11px] italic text-slate-400">
                  calendar event — lives in your calendar, not in goals
                </div>
              )}
            </div>
            {goal && (
              <button
                type="button"
                onClick={() => onLink(task.id, goal.id)}
                className="flex-none rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                title={`Link to ${goal.title}`}
              >
                ✓ Link
              </button>
            )}
            <button
              type="button"
              onClick={() => onDismiss(task.id)}
              className="flex-none rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500 hover:border-slate-400 hover:text-slate-700"
              title="Hide from this list"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
