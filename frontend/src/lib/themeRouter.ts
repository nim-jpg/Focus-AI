import type { Goal, Task, Theme } from "@/types/task";

/**
 * Lightweight keyword router for tasks → themes.
 *
 * Used by:
 *  - `SuggestedGoalLinks` (the "Suggested for your goals" panel) to find
 *    candidate goals for unlinked tasks.
 *  - `Goals.tsx`'s `runMatchAll` (the "✨ Match tasks to goals" button)
 *    as a deterministic pre-pass BEFORE the AI call — anything we can
 *    confidently theme-route locally avoids a round-trip and cuts the
 *    AI work to the genuinely-ambiguous cases.
 *
 * Every keyword here gracefully degrades when no goal of the target
 * theme exists — `pickGoalForTask` returns null in that case — so it's
 * safe to extend the rule list aggressively.
 */
export function inferTaskTheme(task: Pick<Task, "title" | "theme">): Theme {
  const title = task.title.toLowerCase();

  // Education / school — the user explicitly called this out.
  if (/\bexam(s)?\b/.test(title)) return "school";
  if (/\bcourse(s)?\b|\bstudy\b|\brevision\b|\bclass(es)?\b|\bassignment(s)?\b/.test(title))
    return "school";
  if (/\bdissertation\b|\bthesis\b|\blecture(s)?\b|\bsemester\b/.test(title))
    return "school";

  // Fitness — anything that smells like physical training.
  if (
    /\bgym\b|\bworkout\b|\brun(ning)?\b|\bjog(ging)?\b|\btraining session\b/.test(
      title,
    )
  )
    return "fitness";
  if (/\byoga\b|\bpilates\b|\bswim(ming)?\b|\bcycle|\bstretch(ing)?\b/.test(title))
    return "fitness";
  if (/\bweight (lift|train|session)|\bcardio\b|\bsteps\b/.test(title))
    return "fitness";

  // Finance / money. "tax", "invoice", "bills" are unambiguous.
  if (/\bbill(s)?\b|\binvoice(s)?\b|\btax\b|\bpayroll\b|\bvat\b/.test(title))
    return "finance";
  if (/\baccounts? (filing|prep|payable|receivable)|\bbookkeeping\b/.test(title))
    return "finance";
  if (/\bsalary\b|\bpension\b|\bsavings\b|\bbudget(ing)?\b/.test(title))
    return "finance";

  // Medication / health admin — "prescription", "GP", "doctor", etc.
  if (/\bgp\b|\bdoctor\b|\bdentist\b|\bdental\b|\boptician\b/.test(title))
    return "medication";
  if (/\bprescription(s)?\b|\bpharmacy\b|\brepeat (med|prescription)/.test(title))
    return "medication";
  if (/\bblood test\b|\bsmear\b|\bvaccin(e|ation)\b|\bjab\b/.test(title))
    return "medication";

  // Diet
  if (/\bmeal prep\b|\bdiet\b|\bgrocery\b|\bgroceries\b/.test(title))
    return "diet";

  // Household chores.
  if (
    /\b(laundry|dishes|hoover|vacuum|tidy|clean(ing)?|bin(s)?|recycl(e|ing))\b/.test(
      title,
    )
  )
    return "household";
  if (/\bplumber\b|\belectrician\b|\bboiler\b|\brepair (man|person)?\b/.test(title))
    return "household";

  // Development / personal projects.
  if (/\bcommit\b|\bpr\b|\bpull request\b|\brefactor\b|\bdebug\b|\bbug\b/.test(title))
    return "development";
  if (/\bship\b|\bdeploy\b|\brelease\b|\bcode review\b/.test(title))
    return "development";

  return task.theme;
}

/**
 * Given a task and the user's full goal set, pick the goal that should
 * receive this task — null if no plausible bucket exists. The most
 * recently updated goal of the matching theme wins (so users actively
 * working on a goal will see new theme-matched tasks land there).
 *
 * Pure function: does NOT mutate, does NOT hit the network. Cheap to
 * call inside renders or loops.
 */
export function pickGoalForTask(
  task: Pick<Task, "title" | "theme">,
  goals: Goal[],
): Goal | null {
  if (goals.length === 0) return null;
  const theme = inferTaskTheme(task);
  const matching = goals.filter((g) => g.theme === theme);
  if (matching.length === 0) return null;
  return [...matching].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )[0];
}

/**
 * Build a deterministic "auto-link" plan over an entire task list,
 * applying the theme-router to each unlinked, non-appointment, non-
 * snoozed, open task. Returns one entry per task that has a clear
 * goal home — the caller can apply them all in one batch.
 *
 * Used by the "✨ Match tasks to goals" button as the first pass.
 * Any task NOT covered here can fall through to the AI semantic
 * matcher (`suggestGoalTasks`) for the fuzzier cases.
 */
export interface PlannedLink {
  taskId: string;
  goalId: string;
  reason: string;
}

export function planThemeBucketLinks(
  tasks: Task[],
  goals: Goal[],
): PlannedLink[] {
  if (goals.length === 0) return [];
  const out: PlannedLink[] = [];
  const now = Date.now();
  for (const task of tasks) {
    if (task.status === "completed") continue;
    if (task.calendarEventId) continue; // appointments live in the calendar
    if ((task.goalIds ?? []).length > 0) continue;
    if (task.snoozedUntil && new Date(task.snoozedUntil).getTime() > now)
      continue;

    const goal = pickGoalForTask(task, goals);
    if (!goal) continue;
    const inferred = inferTaskTheme(task);
    const reason =
      inferred !== task.theme
        ? `keyword routes ${task.theme} → ${inferred}`
        : `theme: ${inferred}`;
    out.push({ taskId: task.id, goalId: goal.id, reason });
  }
  return out;
}
