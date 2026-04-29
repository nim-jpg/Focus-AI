import type {
  Goal,
  PrioritizedTask,
  Task,
  Theme,
  UserPrefs,
} from "@/types/task";
import { isFoundation, isDueNow } from "./recurrence";
import { isInWorkMode } from "./modeFilter";

// Tasks linked to one of the user's goals are the things they actually want
// to make progress on — those should heavily outrank generic background work,
// even goal-less items with high urgency. Weights bumped from the original
// 60/90/140/180 so a 1y goal-linked task lands ahead of a vague "high"
// urgency unflagged item.
const GOAL_HORIZON_WEIGHT: Record<Goal["horizon"], number> = {
  "6m": 120,
  "1y": 180,
  "5y": 240,
  "10y": 280,
};

const HOURS = 60 * 60 * 1000;

/**
 * Map a task to the "impact dimensions" it touches, derived from its theme,
 * recurrence, urgency, and dueDate. The user's priorityFocus picks (in
 * Settings) toggle on big bonuses for matching dimensions — that's how a
 * personal user gets a different Top Three than a self-employed one despite
 * sharing the same engine.
 *
 * A task can light up multiple dimensions ("medication monthly review" hits
 * both health and stress). Each match contributes +250 if the dimension is
 * in the user's priorityFocus, +0 otherwise (we don't penalise non-matches —
 * the existing deadline/avoidance/blocker signals still move them up).
 */
type ImpactDim =
  | "financial"
  | "health"
  | "stress"
  | "family"
  | "career"
  | "learning"
  | "creativity";

function impactDimensionsFor(
  task: Task,
  userType: UserPrefs["userType"] | undefined,
  avoidance: number,
  hoursLeft: number | null,
): ImpactDim[] {
  const dims = new Set<ImpactDim>();

  // Financial — finance theme, OR a non-finance task with a tight deadline
  // and high urgency (often money-adjacent: "send invoice", "pay bill").
  if (task.theme === "finance") dims.add("financial");
  if (
    task.theme !== "finance" &&
    (task.urgency === "high" || task.urgency === "critical") &&
    hoursLeft !== null &&
    hoursLeft <= 14 * 24 &&
    /\b(invoice|tax|vat|salary|pay|bill|payment|refund|claim)\b/i.test(
      task.title,
    )
  ) {
    dims.add("financial");
  }

  // Health — medication or fitness, plus any task whose title mentions
  // doctor / dentist / hospital / surgery (one-off appointments slot in too).
  if (task.theme === "medication" || task.theme === "fitness") {
    dims.add("health");
  }
  if (
    /\b(doctor|dentist|gp|hospital|surgery|consult|therapy|specialist|scan|test|appointment)\b/i.test(
      task.title,
    )
  ) {
    dims.add("health");
  }

  // Stress — anything long-avoided OR already overdue. The whole point of
  // surfacing these in Top Three is to break the avoidance pattern, which
  // is itself a stress driver.
  if (avoidance >= 2) dims.add("stress");
  if (hoursLeft !== null && hoursLeft < 0) dims.add("stress");
  if (task.isBlocker || (task.blockedBy?.length ?? 0) > 0) dims.add("stress");

  // Family — personal/household tasks whose title hints at people.
  if (
    (task.theme === "personal" || task.theme === "household") &&
    /\b(kid|kids|child|children|partner|wife|husband|mum|mom|dad|family|school|nursery|birthday|anniversary)\b/i.test(
      task.title,
    )
  ) {
    dims.add("family");
  }

  // Career — depends on userType because what counts as "career-driving"
  // shifts (employee = work theme; self-employed = work theme; retired =
  // projects only).
  if (task.theme === "work") dims.add("career");
  if (
    userType === "self-employed" &&
    (task.theme === "work" || task.theme === "projects")
  ) {
    dims.add("career");
  }
  if (userType === "retired" && task.theme === "projects") {
    dims.add("career");
  }

  // Learning — development + school always; "course / study / read /
  // learn" titles too.
  if (task.theme === "development" || task.theme === "school") {
    dims.add("learning");
  }
  if (/\b(study|read|course|certif|learn|practice)\b/i.test(task.title)) {
    dims.add("learning");
  }

  // Creativity — projects (one's own non-day-job builds), or anything with
  // "build / design / write / create" in the title.
  if (task.theme === "projects") dims.add("creativity");
  if (
    /\b(build|design|write|create|sketch|prototype|paint|compose|draft)\b/i.test(
      task.title,
    )
  ) {
    dims.add("creativity");
  }

  return Array.from(dims);
}

function hoursUntil(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const due = new Date(iso).getTime();
  if (Number.isNaN(due)) return null;
  return (due - now.getTime()) / HOURS;
}

function unblocksCount(task: Task, all: Task[]): number {
  return all.filter((t) => t.blockedBy?.includes(task.id)).length;
}

interface Scored {
  task: Task;
  score: number;
  tier: 1 | 2 | 3 | 4;
  reasons: string[];
}

const FOCUS_LABEL: Record<ImpactDim, string> = {
  financial: "money",
  health: "health",
  stress: "stress",
  family: "family",
  career: "work",
  learning: "learning",
  creativity: "creative work",
};

/**
 * Score a single task against the Tier 1-4 rules in the spec.
 * Higher score = more important. Tier is the lowest tier any rule placed it in.
 */
function scoreTask(
  task: Task,
  all: Task[],
  now: Date,
  goalsById: Map<string, Goal>,
  priorityFocus: ImpactDim[],
  userType: UserPrefs["userType"] | undefined,
): Scored {
  const reasons: string[] = [];
  let score = 0;
  let tier: 1 | 2 | 3 | 4 = 4;

  const promote = (t: 1 | 2 | 3 | 4) => {
    if (t < tier) tier = t;
  };

  const hoursLeft = hoursUntil(task.dueDate, now);
  const avoidance = task.avoidanceWeeks ?? 0;

  // Tier 1 — needs hands today.
  if (hoursLeft !== null && hoursLeft <= 48 && hoursLeft >= -24) {
    score += 600;
    promote(1);
    reasons.push(
      hoursLeft <= 0
        ? "overdue — sort today"
        : `due in ${Math.max(1, Math.round(hoursLeft))}h`,
    );
  }
  if (task.urgency === "critical") {
    score += 400;
    promote(1);
    reasons.push("you marked this critical");
  }
  // Avoidance is a primary signal — long-avoided work is what Top Three exists for.
  if (avoidance >= 3) {
    score += 350 + avoidance * 30;
    promote(1);
    reasons.push(`avoided ${avoidance} weeks — break the pattern`);
  }

  // Tier 2 — soon, plan ahead.
  const unlocks = unblocksCount(task, all);
  if (unlocks >= 1) {
    score += 150 + unlocks * 80;
    promote(2);
    reasons.push(
      unlocks === 1 ? "unblocks 1 other thing" : `unblocks ${unlocks} more`,
    );
  }
  if (task.isBlocker) {
    score += 100;
    promote(2);
  }
  if (task.theme === "finance" && hoursLeft !== null && hoursLeft <= 7 * 24) {
    score += 180;
    promote(2);
    reasons.push("money deadline this week");
  }
  if (task.theme === "fitness" && task.recurrence !== "none") {
    score += 90;
    promote(2);
    reasons.push("keeps your streak");
  }
  if (task.theme === "development" && task.recurrence !== "none") {
    score += 80;
    promote(2);
    reasons.push("keeps you learning");
  }

  // Deadline pressure (graded).
  if (hoursLeft !== null && hoursLeft > 48 && hoursLeft <= 7 * 24) {
    const days = hoursLeft / 24;
    score += Math.round(120 / Math.max(1, days));
    if ((task.estimatedMinutes ?? 0) > 30) {
      score += 60;
      promote(2);
      reasons.push(`due in ${Math.ceil(days)}d, takes >30 min`);
    }
  }

  // Urgency baseline.
  score += { low: 0, normal: 20, high: 60, critical: 0 }[task.urgency];

  // Recurrence baseline.
  score += { none: 0, daily: 30, weekly: 15, monthly: 10, quarterly: 8, yearly: 5 }[
    task.recurrence
  ];

  // Tier 3 — milder avoidance (2w) gets a steady nudge.
  if (avoidance === 2) {
    score += 120;
    promote(3);
    reasons.push("avoided 2 weeks — worth nudging");
  }

  // Goal-pull: tasks laddered to a goal get a bump scaled by the longest
  // horizon among them. Long-horizon goals depend on consistent small
  // forward steps, so each ladder-up task is worth surfacing.
  const linkedGoals = (task.goalIds ?? [])
    .map((id) => goalsById.get(id))
    .filter((g): g is Goal => Boolean(g));
  if (linkedGoals.length > 0) {
    const maxWeight = Math.max(
      ...linkedGoals.map((g) => GOAL_HORIZON_WEIGHT[g.horizon] ?? 50),
    );
    // Scale slightly by goal count but cap so a task with 5 goals doesn't dominate
    score += maxWeight + Math.min(linkedGoals.length - 1, 2) * 20;
    promote(2);
    const longestHorizon = linkedGoals.reduce((a, b) =>
      (GOAL_HORIZON_WEIGHT[b.horizon] ?? 0) >
      (GOAL_HORIZON_WEIGHT[a.horizon] ?? 0)
        ? b
        : a,
    );
    reasons.push(
      `your goal: ${longestHorizon.title}`,
    );
  }

  // Impact-dimension bonus — the rebalance that makes Top Three reflect
  // max-impact / biggest-risk items rather than whatever has the soonest
  // deadline. Each dimension this task touches contributes +260 if it's
  // in the user's priorityFocus, +30 otherwise (small acknowledgment so a
  // health task still beats a vague "do thing" task even when health isn't
  // explicitly prioritised).
  const dims = impactDimensionsFor(task, userType, avoidance, hoursLeft);
  const focused = priorityFocus.length > 0;
  let firstFocusReason: string | null = null;
  for (const d of dims) {
    const matches = priorityFocus.includes(d);
    if (matches) {
      score += 260;
      promote(2);
      if (!firstFocusReason) {
        firstFocusReason = `your ${FOCUS_LABEL[d]} focus`;
      }
    } else if (!focused) {
      // Neutral mode: small +30 per dimension so impact-touching tasks
      // still rank above pure background work without distorting the
      // existing engine for users who haven't picked focus areas.
      score += 30;
    }
  }
  // If the user picked a focus and this task hits 2+ of their picks at once,
  // it's a "max impact" item — bonus + tier-1 promotion. This is the
  // mechanism that lets Top Three put e.g. a financial-AND-stress item
  // above a generic deadline.
  if (focused) {
    const overlap = dims.filter((d) => priorityFocus.includes(d)).length;
    if (overlap >= 2) {
      score += 200;
      promote(1);
      reasons.unshift(`fits ${overlap} of your focus areas`);
    } else if (firstFocusReason) {
      reasons.unshift(firstFocusReason);
    }
  }

  // Risk weighting — items with real consequence + a real clock get an
  // extra push. The reasoning text reads honestly without the
  // business-speak overhang.
  const isOverdue = hoursLeft !== null && hoursLeft < 0;
  const nearDeadline = hoursLeft !== null && hoursLeft >= 0 && hoursLeft <= 48;
  if (
    (isOverdue || nearDeadline || avoidance >= 3) &&
    (dims.includes("financial") ||
      dims.includes("health") ||
      task.urgency === "high" ||
      task.urgency === "critical")
  ) {
    score += 200;
    promote(1);
    if (!reasons.some((r) => r.startsWith("slipping"))) {
      reasons.unshift(
        isOverdue
          ? "slipping — overdue and matters"
          : nearDeadline
            ? "slipping — close to due and matters"
            : "slipping — long-avoided and matters",
      );
    }
  }

  // Tier 4 baseline (household etc.) — if nothing else fired, leave as tier 4.
  if (reasons.length === 0) {
    reasons.push("background task");
  }

  return { task, score, tier, reasons };
}

interface PrioritizeOptions {
  prefs?: Partial<UserPrefs>;
  /** Limit to n tasks (default 3). */
  limit?: number;
  /** Override "now" (mostly for tests). */
  now?: Date;
  /** Goals the task list might ladder up to. Used for goal-pull bonus. */
  goals?: Goal[];
}

/**
 * Pick the user's top N tasks, applying theme-balance and mode rules.
 */
export function prioritize(
  tasks: Task[],
  options: PrioritizeOptions = {},
): PrioritizedTask[] {
  const { limit = 3, now = new Date(), goals = [] } = options;
  const mode = options.prefs?.mode ?? "both";
  const priorityFocus = (options.prefs?.priorityFocus ?? []) as ImpactDim[];
  const goalsById = new Map(goals.map((g) => [g.id, g]));

  // Hard 6-month cutoff: a deadline more than 6 months out is, by
  // definition, not what you should be focusing on now. The whole point of
  // a "Top Three" is short-to-medium-horizon attention; quarterly /
  // annual filings due in 2027 don't belong on today's page even if their
  // urgency tag is high. Recurring tasks (medication, fitness, weekly
  // habits) and tasks with NO deadline are NOT affected.
  const SIX_MONTHS_HOURS = 6 * 30 * 24;

  const userType = options.prefs?.userType;
  const candidates = tasks.filter((t) => {
    if (t.status === "completed") return false;
    if (mode === "work" && !isInWorkMode(t, userType)) return false;
    if (mode === "personal" && isInWorkMode(t, userType)) return false;
    // Daily foundational habits live in the Foundations rail, never in Top Three.
    if (isFoundation(t)) return false;
    // Recurring tasks only compete when they're actually due.
    if (t.recurrence !== "none" && !isDueNow(t, now)) return false;
    // Snoozed tasks hide until snoozedUntil passes.
    if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > now.getTime()) {
      return false;
    }
    // Hard 6-month cutoff for non-recurring tasks with deadlines.
    if (t.recurrence === "none" && t.dueDate) {
      const hoursLeft = hoursUntil(t.dueDate, now);
      if (hoursLeft !== null && hoursLeft > SIX_MONTHS_HOURS) return false;
    }
    return true;
  });

  const scored = candidates
    .map((t) =>
      scoreTask(t, candidates, now, goalsById, priorityFocus, userType),
    )
    .sort((a, b) => a.tier - b.tier || b.score - a.score);

  const selected: Scored[] = [];
  const themeCounts = new Map<Theme, number>();

  for (const s of scored) {
    if (selected.length >= limit) break;

    // Theme-balance: never 3 from same theme unless every other theme is empty.
    const used = themeCounts.get(s.task.theme) ?? 0;
    if (used >= 2 && selected.length < limit) {
      const otherThemesAvailable = scored.some(
        (other) =>
          other !== s &&
          !selected.includes(other) &&
          other.task.theme !== s.task.theme,
      );
      if (otherThemesAvailable) continue;
    }

    selected.push(s);
    themeCounts.set(s.task.theme, used + 1);
  }

  return selected.map((s) => ({
    task: s.task,
    score: s.score,
    tier: s.tier,
    reasoning: s.reasons[0]!,
  }));
}
