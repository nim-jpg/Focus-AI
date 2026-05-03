import { useMemo } from "react";
import type { Goal, Task } from "@/types/task";
import { MACRO_THEME_LABELS } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";
import { inferMacroThemes, pickGoalForTask } from "@/lib/themeRouter";
import { isFoundation } from "@/lib/recurrence";

/**
 * Auto-suggested goal links — surfaces the bucket the user keeps asking
 * for: tasks whose theme aligns with one of their goals, batched up so
 * they can tick to link or X to exclude. Calendar appointments stay out
 * (they're already known about; not "work to organise"). "Exam" / "exams"
 * in the title routes to school theme even when the task itself is
 * tagged differently — the user explicitly called this out as a desired
 * mapping.
 *
 * Render this at the top of either Goals tab (desktop or iOS). When the
 * suggestion list is empty the component returns null so it doesn't
 * waste vertical space.
 */
interface Suggestion {
  task: Task;
  goal: Goal;
  /** Why we picked this goal — "theme match" / "exam → school". Surfaced
   *  so the user understands the auto-link rather than seeing a magic
   *  pairing. */
  reason: string;
}

interface Props {
  tasks: Task[];
  goals: Goal[];
  /** Ids the user has explicitly dismissed — stored in
   *  prefs.dismissedGoalSuggestions so the suggestion doesn't re-appear
   *  next session. */
  dismissedTaskIds: string[];
  /** Link a task to a goal (idempotent). */
  onLink: (taskId: string, goalId: string) => void;
  /** Persist a dismissal so this task drops out of future suggestions
   *  until the user manually re-links it. */
  onDismiss: (taskId: string) => void;
}

export function SuggestedGoalLinks({
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

  const suggestions = useMemo<Suggestion[]>(() => {
    if (goals.length === 0) return [];
    const out: Suggestion[] = [];
    for (const task of tasks) {
      if (task.status === "completed") continue;
      // Skip appointments — already in the calendar, not "work to bucket".
      if (task.calendarEventId) continue;
      // Skip foundations — daily personal habits (meds, creams, walks)
      // belong on the Foundation rail, not in the Goals tab.
      if (isFoundation(task)) continue;
      if ((task.goalIds ?? []).length > 0) continue;
      if (dismissed.has(task.id)) continue;
      if (
        task.snoozedUntil &&
        new Date(task.snoozedUntil).getTime() > Date.now()
      ) {
        continue;
      }

      const goal = pickGoalForTask(task, goals);
      if (!goal) continue;

      const macros = inferMacroThemes(task);
      const overlap = (goal.macroThemes ?? []).filter((m) =>
        macros.includes(m),
      );
      const reason =
        overlap.length > 0
          ? overlap.map((m) => MACRO_THEME_LABELS[m]).join(" + ")
          : `theme: ${task.theme}`;
      out.push({ task, goal, reason });
    }
    return out;
  }, [tasks, goals, dismissed]);

  if (suggestions.length === 0) return null;

  return (
    <div className="card mb-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Suggested for your goals · {suggestions.length}
        </h3>
        <span className="text-[11px] text-slate-500">
          appointments excluded
        </span>
      </div>
      <ul className="space-y-1.5">
        {suggestions.map(({ task, goal, reason }) => (
          <li
            key={task.id}
            className="flex items-center gap-2 rounded-md border border-slate-200/70 bg-white px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-slate-900">
                  {task.title}
                </span>
                <ThemeBadge theme={task.theme} />
              </div>
              <div className="text-[11px] text-slate-500">
                <span className="text-slate-400">→</span>{" "}
                <span className="font-medium text-slate-700">{goal.title}</span>
                <span className="ml-1.5 text-slate-400">· {reason}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onLink(task.id, goal.id)}
              className="flex-none rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
              title={`Link to ${goal.title}`}
              aria-label={`Link ${task.title} to ${goal.title}`}
            >
              ✓ Link
            </button>
            <button
              type="button"
              onClick={() => onDismiss(task.id)}
              className="flex-none rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500 hover:border-slate-400 hover:text-slate-700"
              title="Don't suggest this again"
              aria-label={`Dismiss suggestion for ${task.title}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
