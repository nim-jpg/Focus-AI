import type {
  PrioritizedTask,
  Task,
  Theme,
  UserPrefs,
} from "@/types/task";
import { isBasic, isDueNow } from "./recurrence";

const HOURS = 60 * 60 * 1000;

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

/**
 * Score a single task against the Tier 1-4 rules in the spec.
 * Higher score = more important. Tier is the lowest tier any rule placed it in.
 */
function scoreTask(task: Task, all: Task[], now: Date): Scored {
  const reasons: string[] = [];
  let score = 0;
  let tier: 1 | 2 | 3 | 4 = 4;

  const promote = (t: 1 | 2 | 3 | 4) => {
    if (t < tier) tier = t;
  };

  const hoursLeft = hoursUntil(task.dueDate, now);
  const avoidance = task.avoidanceWeeks ?? 0;

  // Tier 1 — must do now.
  if (hoursLeft !== null && hoursLeft <= 48 && hoursLeft >= -24) {
    score += 600;
    promote(1);
    reasons.push(
      hoursLeft <= 0
        ? "deadline already passed — handle today"
        : `deadline in ${Math.max(1, Math.round(hoursLeft))}h`,
    );
  }
  if (task.urgency === "critical") {
    score += 400;
    promote(1);
    reasons.push("flagged critical");
  }
  // Avoidance is a primary signal — long-avoided work is what Top Three exists for.
  if (avoidance >= 3) {
    score += 350 + avoidance * 30;
    promote(1);
    reasons.push(`avoided ${avoidance} weeks — time to break the pattern`);
  }

  // Tier 2 — moves you forward.
  const unlocks = unblocksCount(task, all);
  if (unlocks >= 1) {
    score += 150 + unlocks * 80;
    promote(2);
    reasons.push(
      unlocks === 1
        ? "unblocks 1 other task"
        : `unblocks ${unlocks} other tasks`,
    );
  }
  if (task.isBlocker) {
    score += 100;
    promote(2);
  }
  if (task.theme === "finance" && hoursLeft !== null && hoursLeft <= 7 * 24) {
    score += 180;
    promote(2);
    reasons.push("finance cutoff this week");
  }
  if (task.theme === "fitness" && task.recurrence !== "none") {
    score += 90;
    promote(2);
    reasons.push("fitness consistency compounds");
  }
  if (task.theme === "development" && task.recurrence !== "none") {
    score += 80;
    promote(2);
    reasons.push("learning momentum");
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
    reasons.push("dodged 2 weeks — surfacing before it grows");
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
}

/**
 * Pick the user's top N tasks, applying theme-balance and mode rules.
 */
export function prioritize(
  tasks: Task[],
  options: PrioritizeOptions = {},
): PrioritizedTask[] {
  const { limit = 3, now = new Date() } = options;
  const mode = options.prefs?.mode ?? "both";

  const candidates = tasks.filter((t) => {
    if (t.status === "completed") return false;
    if (mode === "work" && !t.isWork) return false;
    if (mode === "personal" && t.isWork) return false;
    // Daily foundational habits live in the Basics rail, never in Top Three.
    if (isBasic(t)) return false;
    // Recurring tasks only compete when they're actually due.
    if (t.recurrence !== "none" && !isDueNow(t, now)) return false;
    return true;
  });

  const scored = candidates
    .map((t) => scoreTask(t, candidates, now))
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
