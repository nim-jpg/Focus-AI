import type { Recurrence, Task } from "@/types/task";

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
