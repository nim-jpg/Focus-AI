import type { Recurrence, Task, TimeOfDay } from "@/types/task";

const DAY = 24 * 60 * 60 * 1000;

const INTERVAL_DAYS: Record<Exclude<Recurrence, "none" | "daily">, number> = {
  weekly: 6,
  monthly: 28,
  quarterly: 85,
  yearly: 350,
};

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function wasCompletedToday(task: Task, now: Date = new Date()): boolean {
  if (!task.lastCompletedAt) return false;
  const last = new Date(task.lastCompletedAt);
  if (Number.isNaN(last.getTime())) return false;
  return startOfDay(last).getTime() === startOfDay(now).getTime();
}

export function isDueNow(task: Task, now: Date = new Date()): boolean {
  if (task.recurrence === "none") return task.status !== "completed";
  if (!task.lastCompletedAt) return true;

  const last = new Date(task.lastCompletedAt);
  if (Number.isNaN(last.getTime())) return true;

  if (task.recurrence === "daily") {
    return startOfDay(last).getTime() < startOfDay(now).getTime();
  }

  const elapsedDays = (now.getTime() - last.getTime()) / DAY;
  return elapsedDays >= INTERVAL_DAYS[task.recurrence];
}

export function nextDueAt(task: Task, now: Date = new Date()): Date | null {
  if (task.recurrence === "none") return task.dueDate ? new Date(task.dueDate) : null;
  if (!task.lastCompletedAt) return now;

  const last = new Date(task.lastCompletedAt);
  if (Number.isNaN(last.getTime())) return now;

  if (task.recurrence === "daily") {
    const next = startOfDay(last);
    next.setDate(next.getDate() + 1);
    return next;
  }
  return new Date(last.getTime() + INTERVAL_DAYS[task.recurrence] * DAY);
}

const FOUNDATION_THEMES = new Set(["medication", "fitness", "diet"]);

/**
 * A "foundation" is a daily-recurring foundational habit (meds, daily movement,
 * daily nutrition). Foundations live in their own rail and never crowd the Top
 * Three — Top Three is reserved for meaningful, often-avoided work that drives
 * long-term goals.
 */
export function isFoundation(task: Task): boolean {
  return task.recurrence === "daily" && FOUNDATION_THEMES.has(task.theme);
}

/** Counter-style foundations (e.g. drink 8 glasses) — tap to increment, not tick. */
export function isCounter(task: Task): boolean {
  return Boolean(task.counter && task.counter.target > 0);
}

/** Today's tally for a counter task, defaulting to 0 if the stored date is stale. */
export function counterCountToday(task: Task, now: Date = new Date()): number {
  if (!task.counter) return 0;
  const todayStr = now.toISOString().slice(0, 10);
  return task.counter.date === todayStr ? task.counter.count : 0;
}

/** End-of-slot hour (24h). evening + anytime never go overdue same day. */
const SLOT_END_HOUR: Record<TimeOfDay, number> = {
  morning: 12,
  midday: 14,
  afternoon: 18,
  evening: 24,
  anytime: 24,
};

/** A task is "overdue" if its time slot has passed today and it isn't done yet. */
export function isOverdueToday(task: Task, now: Date = new Date()): boolean {
  if (wasCompletedToday(task, now)) return false;
  const slot = task.timeOfDay ?? "anytime";
  if (slot === "anytime") return false;
  return now.getHours() >= SLOT_END_HOUR[slot];
}

/**
 * For a weekly+ recurring task, the most recent date on or before `now` that
 * matches the original schedule anchored to createdAt.
 *  - weekly: same day-of-week as createdAt
 *  - monthly/quarterly/yearly: same day-of-month as createdAt
 * Returns null for non-recurring or daily tasks.
 */
export function intendedScheduleDate(task: Task, now: Date = new Date()): Date | null {
  if (task.recurrence === "none" || task.recurrence === "daily") return null;
  const anchor = new Date(task.createdAt);
  if (Number.isNaN(anchor.getTime())) return null;

  const result = new Date(now);
  result.setHours(0, 0, 0, 0);

  if (task.recurrence === "weekly") {
    const anchorDow = anchor.getDay();
    const todayDow = result.getDay();
    const diff = (todayDow - anchorDow + 7) % 7;
    result.setDate(result.getDate() - diff);
    return result;
  }

  // monthly / quarterly / yearly: walk back to the most recent same-day-of-month.
  const anchorDom = anchor.getDate();
  result.setDate(anchorDom);
  if (result.getTime() > now.getTime()) {
    result.setMonth(result.getMonth() - 1);
  }
  return result;
}

/**
 * True when a recurring task was completed *after* its scheduled instance —
 * i.e. the user is doing it late and we should ask whether to reset the cycle.
 */
export function wasCompletedLate(task: Task, now: Date = new Date()): boolean {
  const intended = intendedScheduleDate(task, now);
  if (!intended) return false;
  // "late" if intended was 1+ days before today
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return intended.getTime() < today.getTime();
}
