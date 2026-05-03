import type { Goal, MacroTheme, Task, Theme } from "@/types/task";

/**
 * Theme → macro-theme fallback. The legacy single-Theme enum (work,
 * projects, personal, school, fitness, finance, diet, medication,
 * development, household) maps to one or two macros each. Used when
 * neither title keywords nor explicit macroThemes give us a signal —
 * stops the matcher from returning [] on goals like "Save money"
 * or tasks like "review notes" whose titles don't trigger the regex
 * router but whose theme is unambiguous.
 *
 * `personal` and `household` deliberately return [] — those aren't
 * MEANINGFUL macro buckets (every task could be "personal"), so
 * they fall through cleanly when the title also has no signal.
 */
function themeToMacros(theme: Theme): MacroTheme[] {
  switch (theme) {
    case "work":
      return ["career"];
    case "projects":
      return ["creativity"];
    case "school":
      return ["learning"];
    case "fitness":
      return ["health"];
    case "diet":
      return ["health"];
    case "medication":
      return ["health"];
    case "finance":
      return ["financial"];
    case "development":
      return ["learning", "creativity"];
    case "household":
    case "personal":
    default:
      return [];
  }
}

/**
 * Multi-target keyword router for tasks → macro-themes.
 *
 * Real tasks belong to multiple buckets at once: "file 2024 tax return"
 * is financial AND admin AND stress (you've been avoiding it). The
 * router emits all three, so a goal tagged with any of those macro-
 * themes can claim the task. Output ordering doesn't matter — callers
 * intersect with goal.macroThemes to find a home.
 *
 * `theme` (Theme — work/projects/personal/...) is a separate axis kept
 * for backwards compatibility (Foundation tile colours, ThemeBadge,
 * etc.). MacroTheme is the new axis the goal-matcher operates on.
 *
 * Used by:
 *  - `SuggestedGoalLinks` — shows tasks routed to goals via macro-theme
 *    overlap.
 *  - `Goals.tsx`'s `runMatchAll` — deterministic pre-pass before the
 *    AI semantic matcher.
 *  - `UnmappedTasks` panel — surfaces unlinked tasks with their
 *    auto-detected macro-theme labels even when no goal exists yet.
 *
 * Add keywords aggressively: every entry gracefully degrades when no
 * goal of the target macroTheme exists.
 */
export function inferMacroThemes(
  task: Pick<Task, "title" | "theme" | "description" | "calendarEventId">,
): MacroTheme[] {
  const haystack = `${task.title} ${task.description ?? ""}`.toLowerCase();
  const out = new Set<MacroTheme>();

  // Theme-derived macros first — every task gets at least its theme's
  // implied bucket(s) before keyword routes pile on more. Stops the
  // matcher from returning [] on tasks/goals whose titles don't
  // trigger any keyword (e.g. "review notes" with theme=school still
  // ends up as "learning"). `personal` / `household` map to nothing
  // because they're catch-all buckets that wouldn't add useful signal.
  for (const m of themeToMacros(task.theme)) out.add(m);

  // ─── EVENTS ─────────────────────────────────────────────────────────
  // Calendar-derived tasks are events by definition. Bare-title heuristics
  // still help for manually-added meetings the user typed in.
  if (task.calendarEventId) out.add("events");
  if (
    /\bmeeting\b|\bcall (with|w\/)|\binterview\b|\bappointment\b|\b1:?1\b/.test(
      haystack,
    )
  ) {
    out.add("events");
  }
  if (/\bbirthday\b|\bdinner\b|\bparty\b|\bdrinks\b|\bcatch up\b/.test(haystack)) {
    out.add("events");
  }
  if (/\bwedding\b|\bfuneral\b|\bcelebration\b|\bservice\b/.test(haystack)) {
    out.add("events");
  }

  // ─── ADMIN ──────────────────────────────────────────────────────────
  // Paperwork, filings, statutory deadlines, anything procedural.
  // Many of these double as stress (avoidance fuel).
  if (
    /\bfile [a-z]+|\bsubmit\b|\brenew(al)?\b|\bregister\b|\bregistration\b/.test(
      haystack,
    )
  ) {
    out.add("admin");
    out.add("stress");
  }
  if (
    /\b(confirmation statement|annual return|companies house|hmrc|self.?assessment)\b/.test(
      haystack,
    )
  ) {
    out.add("admin");
    out.add("financial");
    out.add("stress");
  }
  if (/\bpassport\b|\bdriving licen[cs]e\b|\bvisa\b|\bdvla\b/.test(haystack)) {
    out.add("admin");
  }
  if (/\binsurance\b|\bcontract\b|\bagreement\b|\blegal\b/.test(haystack)) {
    out.add("admin");
  }
  if (/\bdeadline\b|\boverdue\b|\bchase\b|\bfollow.?up\b/.test(haystack)) {
    out.add("admin");
    out.add("stress");
  }

  // ─── FINANCIAL ──────────────────────────────────────────────────────
  if (
    /\bbill(s)?\b|\binvoice(s)?\b|\btax\b|\bpayroll\b|\bvat\b|\bpayment\b/.test(
      haystack,
    )
  ) {
    out.add("financial");
  }
  if (
    /\bsalary\b|\bpension\b|\bsavings\b|\bbudget(ing)?\b|\binvestment\b/.test(
      haystack,
    )
  ) {
    out.add("financial");
  }
  if (
    /\bmortgage\b|\brefinanc(e|ing)\b|\bbank\b|\baccount(s)? (filing|prep|payable|receivable)|\bbookkeeping\b/.test(
      haystack,
    )
  ) {
    out.add("financial");
  }
  if (/\bdebt\b|\bloan\b|\bcredit card\b/.test(haystack)) {
    out.add("financial");
    out.add("stress");
  }

  // ─── LEARNING / EDUCATION ───────────────────────────────────────────
  // The user's specific call-out: "education related did not add to the
  // learning goal". Catches both academic and self-directed learning.
  if (/\beducation(al)?\b|\blearn(ing)?\b|\bstud(y|ying|ies)\b/.test(haystack)) {
    out.add("learning");
  }
  if (
    /\bexam(s)?\b|\brevision\b|\bdissertation\b|\bthesis\b|\bessay\b/.test(
      haystack,
    )
  ) {
    out.add("learning");
  }
  if (
    /\bcourse(s)?\b|\bclass(es)?\b|\bassignment(s)?\b|\blecture(s)?\b|\bsemester\b/.test(
      haystack,
    )
  ) {
    out.add("learning");
  }
  if (
    /\btraining\b|\bworkshop\b|\bcertification\b|\bqualif(y|ication)\b|\bskill(s)?\b/.test(
      haystack,
    )
  ) {
    out.add("learning");
  }
  if (
    /\bread (book|chapter)|\btutorial\b|\bdocs\b|\bdocumentation\b|\bresearch\b/.test(
      haystack,
    )
  ) {
    out.add("learning");
  }

  // ─── HEALTH ─────────────────────────────────────────────────────────
  // Fitness + medical admin. Medical appointments also pick up "events".
  if (
    /\bgym\b|\bworkout\b|\brun(ning)?\b|\bjog(ging)?\b|\btraining session\b/.test(
      haystack,
    )
  ) {
    out.add("health");
  }
  if (/\byoga\b|\bpilates\b|\bswim(ming)?\b|\bcycle\b|\bstretch(ing)?\b/.test(haystack)) {
    out.add("health");
  }
  if (/\bweight (lift|train|session)|\bcardio\b|\bsteps\b/.test(haystack)) {
    out.add("health");
  }
  if (/\bgp\b|\bdoctor\b|\bdentist\b|\bdental\b|\boptician\b/.test(haystack)) {
    out.add("health");
    out.add("events");
  }
  if (/\bprescription(s)?\b|\bpharmacy\b|\brepeat (med|prescription)/.test(haystack)) {
    out.add("health");
    out.add("admin");
  }
  if (/\bblood test\b|\bsmear\b|\bvaccin(e|ation)\b|\bjab\b/.test(haystack)) {
    out.add("health");
    out.add("events");
  }
  if (/\btherapy\b|\btherapist\b|\bcounsel(l)?ing\b|\bmental health\b/.test(haystack)) {
    out.add("health");
    out.add("stress");
  }

  // ─── FAMILY ─────────────────────────────────────────────────────────
  if (
    /\bkid(s)?\b|\bchild(ren)?\b|\bson\b|\bdaughter\b|\bschool run\b/.test(
      haystack,
    )
  ) {
    out.add("family");
  }
  if (
    /\bmum\b|\bmom\b|\bdad\b|\bparent(s)?\b|\bsister\b|\bbrother\b|\bgran\b/.test(
      haystack,
    )
  ) {
    out.add("family");
  }
  if (/\bpartner\b|\bwife\b|\bhusband\b|\bspouse\b|\banniversary\b/.test(haystack)) {
    out.add("family");
  }

  // ─── CAREER ─────────────────────────────────────────────────────────
  if (/\bperformance review\b|\b1:1\b|\bcv\b|\bresume\b|\bjob (apply|search|interview)/.test(haystack)) {
    out.add("career");
  }
  if (/\bproposal\b|\bpitch\b|\bdeck\b|\bclient (call|meeting|review)/.test(haystack)) {
    out.add("career");
  }
  // Business / entrepreneurial — covers self-employment, side-hustles,
  // founders. Picks up both "career" (it's their work) AND "financial"
  // (revenue/monetisation goals).
  if (
    /\bbusiness\b|\brevenue\b|\bsales\b|\bmrr\b|\barr\b|\bsubscription\b/.test(
      haystack,
    )
  ) {
    out.add("career");
    out.add("financial");
  }
  if (
    /\bcustomer(s)?\b|\bclient(s)?\b|\blead(s)?\b|\bpipeline\b|\bmarketing\b/.test(
      haystack,
    )
  ) {
    out.add("career");
  }
  if (
    /\bproduct\b|\blaunch\b|\bgo.?to.?market\b|\bgtm\b|\bstartup\b/.test(
      haystack,
    )
  ) {
    out.add("career");
  }

  // ─── CREATIVITY ────────────────────────────────────────────────────
  if (
    /\bdesign\b|\bsketch\b|\bmood ?board\b|\bdraft\b|\bcompose\b|\bwrite (post|article|blog)/.test(
      haystack,
    )
  ) {
    out.add("creativity");
  }
  if (/\bvideo\b|\bphoto\b|\bedit (clip|reel|video)|\bmusic\b/.test(haystack)) {
    out.add("creativity");
  }

  // ─── STRESS (catch-all) ────────────────────────────────────────────
  // Anything explicitly flagged stressful by language gets added.
  if (
    /\bavoiding\b|\bdread\b|\boverwhelm(ed|ing)?\b|\banxious\b|\banxiety\b/.test(
      haystack,
    )
  ) {
    out.add("stress");
  }

  return Array.from(out);
}

/**
 * Resolve a goal's macro-themes — explicit when the user set them,
 * otherwise inferred from the goal's title+notes via the same router
 * tasks use. So a brand-new "Education" goal automatically picks up
 * `["learning"]` and starts catching exam/study/course-titled tasks
 * without the user having to tag the goal manually. The user can
 * still override by setting macroThemes explicitly via the Goal form.
 */
export function resolveGoalMacroThemes(goal: Goal): MacroTheme[] {
  if (goal.macroThemes && goal.macroThemes.length > 0) {
    return goal.macroThemes;
  }
  return inferMacroThemes({
    title: goal.title,
    theme: goal.theme,
    description: goal.notes,
    calendarEventId: undefined,
  });
}

/**
 * Picks the most plausible goal for a task. Strategy:
 *   1. task's inferred macro-themes ∩ goal's resolved macroThemes (best)
 *   2. task.theme === goal.theme (legacy strict fallback)
 *
 * Most-recently-updated goal of the matching set wins. Returns null if
 * nothing plausible exists — caller can route the task to the
 * "Unmapped" bucket instead.
 */
export function pickGoalForTask(
  task: Task,
  goals: Goal[],
): Goal | null {
  if (goals.length === 0) return null;
  const macros = inferMacroThemes(task);
  const macroSet = new Set(macros);

  // Prefer goals whose resolved macroThemes overlap with the task's.
  const withMacroOverlap = goals.filter((g) =>
    resolveGoalMacroThemes(g).some((m) => macroSet.has(m)),
  );
  if (withMacroOverlap.length > 0) {
    return [...withMacroOverlap].sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0];
  }

  // Legacy fallback — goal.theme === task.theme. Skips events/admin
  // which don't map cleanly to the Theme enum.
  const legacy = goals.filter((g) => g.theme === task.theme);
  if (legacy.length === 0) return null;
  return [...legacy].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )[0];
}

export interface PlannedLink {
  taskId: string;
  goalId: string;
  reason: string;
}

/**
 * Build a deterministic auto-link plan over an entire task list. Each
 * unlinked, non-snoozed, open task gets routed to one goal via macro-
 * theme overlap. Calendar events are SKIPPED — they live in the
 * calendar; pulling them into goal buckets clutters the Goals view.
 *
 * Used by the "✨ Match tasks to goals" button as the deterministic
 * pre-pass before the AI matcher.
 */
export function planThemeBucketLinks(
  tasks: Task[],
  goals: Goal[],
): PlannedLink[] {
  if (goals.length === 0) return [];
  const out: PlannedLink[] = [];
  const now = Date.now();
  for (const task of tasks) {
    if (task.status === "completed") continue;
    if (task.calendarEventId) continue;
    if ((task.goalIds ?? []).length > 0) continue;
    if (task.snoozedUntil && new Date(task.snoozedUntil).getTime() > now)
      continue;

    const goal = pickGoalForTask(task, goals);
    if (!goal) continue;
    const macros = inferMacroThemes(task);
    const goalMacros = resolveGoalMacroThemes(goal);
    const overlap = goalMacros.filter((m) => macros.includes(m));
    const reason =
      overlap.length > 0
        ? `${overlap.join(" + ")} → ${goal.title}`
        : `theme: ${task.theme}`;
    out.push({ taskId: task.id, goalId: goal.id, reason });
  }
  return out;
}
