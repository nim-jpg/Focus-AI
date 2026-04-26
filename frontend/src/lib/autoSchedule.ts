import type { Task } from "@/types/task";
import type { CalendarEvent } from "./googleCalendar";

const DAY_MS = 24 * 60 * 60 * 1000;

interface BusyBlock {
  start: number;
  end: number;
}

/** Working-hours assumption — Mon-Fri 9-18 are blocked by default. */
const DEFAULT_WORK_START = 9;
const DEFAULT_WORK_END = 18;

/** Slot preference rules per day-of-week (0=Sun..6=Sat). */
function preferredSlotsFor(dayOfWeek: number): Array<{ hour: number; minute: number }> {
  // Weekend (Sat=6, Sun=0): early morning preferred
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return [
      { hour: 9, minute: 0 },
      { hour: 10, minute: 30 },
      { hour: 8, minute: 0 },
      { hour: 11, minute: 30 },
    ];
  }
  // Weekday: after-work slots preferred
  return [
    { hour: 19, minute: 0 },
    { hour: 18, minute: 30 },
    { hour: 20, minute: 0 },
    { hour: 7, minute: 0 },
  ];
}

function isWorkHours(date: Date): boolean {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  const h = date.getHours();
  return h >= DEFAULT_WORK_START && h < DEFAULT_WORK_END;
}

function overlaps(start: number, end: number, busy: BusyBlock[]): boolean {
  for (const b of busy) {
    if (start < b.end && end > b.start) return true;
  }
  return false;
}

/**
 * Suggest N session start times for the given week, avoiding clashes with
 * existing busy blocks (other tasks' scheduledFor / sessionTimes / Google
 * events), avoiding default work hours, and biased to weekend mornings +
 * weekday evenings.
 *
 * Spreads across distinct days first (one session per day) before doubling up.
 */
export function suggestSessionTimes(
  count: number,
  durationMinutes: number,
  weekStart: Date,
  busy: BusyBlock[],
): Date[] {
  if (count <= 0) return [];

  const placed: Date[] = [];
  const localBusy = [...busy];

  // Score days: weekend > evening-weekday > anything else
  const dayOrder: number[] = [];
  // First pass: weekends, then weekdays
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * DAY_MS);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) dayOrder.unshift(i);
    else dayOrder.push(i);
  }

  const tryDay = (dayOffset: number): Date | null => {
    const date = new Date(weekStart.getTime() + dayOffset * DAY_MS);
    const dow = date.getDay();
    const slots = preferredSlotsFor(dow);
    for (const slot of slots) {
      const candidate = new Date(date);
      candidate.setHours(slot.hour, slot.minute, 0, 0);
      // Don't propose past times
      if (candidate.getTime() < Date.now()) continue;
      if (isWorkHours(candidate)) continue;
      const start = candidate.getTime();
      const end = start + durationMinutes * 60 * 1000;
      if (overlaps(start, end, localBusy)) continue;
      // Block this slot to avoid double-booking with later sessions
      localBusy.push({ start, end });
      return candidate;
    }
    return null;
  };

  // Pass 1: one session per distinct day, in priority order
  for (const dayIdx of dayOrder) {
    if (placed.length >= count) break;
    const slot = tryDay(dayIdx);
    if (slot) placed.push(slot);
  }

  // Pass 2: if still under count, allow second slot per day (any remaining slot)
  if (placed.length < count) {
    for (const dayIdx of dayOrder) {
      if (placed.length >= count) break;
      const slot = tryDay(dayIdx);
      if (slot) placed.push(slot);
    }
  }

  return placed.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Collect all currently-busy windows for the upcoming week, from:
 *  - Google Calendar events (passed in)
 *  - Other tasks' scheduledFor + estimatedMinutes
 *  - Other tasks' sessionTimes (excluding the task being scheduled itself)
 *  - dueDates falling within the week (treated as one-hour blocks)
 */
export function busyWindowsForWeek(
  weekStart: Date,
  weekEnd: Date,
  tasks: Task[],
  events: CalendarEvent[],
  excludeTaskId?: string,
): BusyBlock[] {
  const busy: BusyBlock[] = [];

  for (const ev of events) {
    if (!ev.start || !ev.end) continue;
    const s = new Date(ev.start).getTime();
    const e = new Date(ev.end).getTime();
    if (e < weekStart.getTime() || s > weekEnd.getTime()) continue;
    busy.push({ start: s, end: e });
  }

  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (t.status === "completed") continue;
    const dur = (t.estimatedMinutes ?? 60) * 60 * 1000;
    if (t.scheduledFor) {
      const s = new Date(t.scheduledFor).getTime();
      if (s >= weekStart.getTime() && s < weekEnd.getTime()) {
        busy.push({ start: s, end: s + dur });
      }
    }
    for (const iso of t.sessionTimes ?? []) {
      const s = new Date(iso).getTime();
      if (s >= weekStart.getTime() && s < weekEnd.getTime()) {
        busy.push({ start: s, end: s + dur });
      }
    }
  }

  return busy;
}
