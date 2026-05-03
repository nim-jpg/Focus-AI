import { useMemo } from "react";
import type { Goal, Task, Theme } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";

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

/** Lightweight keyword router. The user explicitly asked for "exam" to
 *  route to education/school. Add more entries here over time as user
 *  feedback identifies common pairings — every entry here gracefully
 *  degrades when no goal of the target theme exists, so it's safe to
 *  expand. */
function inferTheme(task: Task): Theme {
  const title = task.title.toLowerCase();
  if (/\bexam(s)?\b/.test(title)) return "school";
  if (/\bcourse(s)?\b|\bstudy\b|\brevision\b/.test(title)) return "school";
  if (/\bgym\b|\bworkout\b|\brun\b|\btraining session\b/.test(title))
    return "fitness";
  if (/\bbill(s)?\b|\binvoice(s)?\b|\btax\b|\bpayroll\b/.test(title))
    return "finance";
  return task.theme;
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
    // Group goals by theme so we can pick the most-recently-active one
    // per theme as the suggestion target. Falls back to the first goal
    // of the theme if none has activity.
    const goalsByTheme = new Map<Theme, Goal[]>();
    for (const g of goals) {
      const arr = goalsByTheme.get(g.theme) ?? [];
      arr.push(g);
      goalsByTheme.set(g.theme, arr);
    }

    const out: Suggestion[] = [];
    for (const task of tasks) {
      if (task.status === "completed") continue;
      // Skip appointments — they're booked in the user's calendar so
      // they're already "managed". Top-Three filtering does the same.
      if (task.calendarEventId) continue;
      // Already linked to ANY goal? Don't suggest another.
      if ((task.goalIds ?? []).length > 0) continue;
      if (dismissed.has(task.id)) continue;
      // Snoozed tasks aren't "active work" right now — skip until they
      // wake up, otherwise the suggestion list fills with deferred junk.
      if (
        task.snoozedUntil &&
        new Date(task.snoozedUntil).getTime() > Date.now()
      ) {
        continue;
      }

      const inferredTheme = inferTheme(task);
      const candidates = goalsByTheme.get(inferredTheme) ?? [];
      if (candidates.length === 0) continue;
      // Prefer the most recently updated goal of the matching theme.
      const goal = [...candidates].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0];

      const reason =
        inferredTheme !== task.theme
          ? `${task.theme} → keyword routes to ${inferredTheme}`
          : `theme: ${inferredTheme}`;

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
