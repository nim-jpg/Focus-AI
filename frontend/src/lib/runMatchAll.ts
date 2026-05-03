import type { Goal, Task } from "@/types/task";
import { planThemeBucketLinks } from "@/lib/themeRouter";
import { suggestGoalTasks, type GoalTaskMatch } from "@/lib/suggestGoalTasks";

/**
 * Auto-link result. The orchestrator returns one entry per task that
 * landed under a goal — the caller persists each via `onLink`. The
 * confidence + reason fields come from either the keyword router
 * (high confidence, deterministic reason) or the AI matcher (model
 * confidence + reason).
 */
export interface AppliedMatch extends GoalTaskMatch {
  goalId: string;
}

export interface RunMatchAllResult {
  applied: AppliedMatch[];
  /** True when the AI second-pass errored (network / rate-limit / etc).
   *  Keyword-pass results are still in `applied` either way. */
  aiError?: string;
}

/**
 * Two-pass goal matcher used by both the desktop Goals tab's
 * "✨ Match tasks to goals" button and the centralised AI button:
 *
 *   1. Deterministic theme-bucket + keyword routing — instant, no API,
 *      catches obvious cases (exam → Learning, tax → Money + Stress,
 *      gym → Health, etc.).
 *   2. AI semantic matcher — only on tasks the keyword pass didn't
 *      reach. Per-goal, sequential to keep request volume modest.
 *
 * `onLink` is invoked for each successful match; the caller is
 * responsible for persisting (typically `updateTask({ goalIds: [...] })`).
 *
 * Calendar appointments are always skipped (they live on the calendar,
 * not in goals) — same logic as the rest of the goal pipeline.
 */
export async function runMatchAll(
  tasks: Task[],
  goals: Goal[],
  onLink: (taskId: string, goalId: string) => void,
): Promise<RunMatchAllResult> {
  if (goals.length === 0) {
    return { applied: [] };
  }

  const applied: AppliedMatch[] = [];

  // ─── Pass 1: deterministic ─────────────────────────────────────────
  const planned = planThemeBucketLinks(tasks, goals);
  const themedTaskIds = new Set<string>();
  for (const link of planned) {
    onLink(link.taskId, link.goalId);
    applied.push({
      taskId: link.taskId,
      goalId: link.goalId,
      confidence: "high",
      reason: link.reason,
    });
    themedTaskIds.add(link.taskId);
  }

  // ─── Pass 2: AI semantic matcher (only on what's left) ─────────────
  let aiError: string | undefined;
  try {
    for (const g of goals) {
      const candidates = tasks.filter(
        (t) =>
          t.status !== "completed" &&
          !(t.goalIds ?? []).includes(g.id) &&
          !themedTaskIds.has(t.id) &&
          !t.calendarEventId,
      );
      if (candidates.length === 0) continue;
      const matches = await suggestGoalTasks(g, candidates);
      for (const m of matches) {
        onLink(m.taskId, g.id);
        applied.push({ ...m, goalId: g.id });
      }
    }
  } catch (err) {
    aiError = err instanceof Error ? err.message : "AI unavailable";
  }

  return { applied, aiError };
}
