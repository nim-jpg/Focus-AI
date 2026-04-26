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
 * Pre-computed even-spread day patterns indexed by N. Each value is a list of
 * day offsets from week start (0=Mon..6=Sun). Patterns chosen for:
 *   - max gap between consecutive days (no back-to-back when avoidable)
 *   - at least one weekend day for sanity
 */
const SPREAD_PATTERNS: Record<number, number[]> = {
  1: [5],                    // Sat
  2: [2, 5],                 // Wed, Sat
  3: [1, 3, 5],              // Tue, Thu, Sat
  4: [0, 2, 4, 6],           // Mon, Wed, Fri, Sun
  5: [0, 2, 3, 5, 6],        // Mon, Wed, Thu, Sat, Sun
  6: [0, 1, 3, 4, 5, 6],     // Mon, Tue, Thu, Fri, Sat, Sun
  7: [0, 1, 2, 3, 4, 5, 6],
};

const MIN_GAP_HOURS = 16; // hard floor between consecutive sessions

/**
 * Suggest N session start times for the given week.
 *
 * Strategy:
 *  1. Pick N days using SPREAD_PATTERNS so sessions are spread out (no
 *     back-to-back days when avoidable).
 *  2. For each day, try its preferred slots (weekend mornings, weekday evenings).
 *  3. If a day has no free slot, fall back to neighbouring days.
 *  4. Reject any candidate that lands within MIN_GAP_HOURS of an already-
 *     placed session, or clashes with existing busy blocks.
 */
export function suggestSessionTimes(
  count: number,
  durationMinutes: number,
  weekStart: Date,
  busy: BusyBlock[],
): Date[] {
  if (count <= 0) return [];
  const n = Math.min(count, 7);

  const placed: Date[] = [];
  const localBusy = [...busy];

  const tryDayWithSlot = (dayOffset: number): Date | null => {
    const date = new Date(weekStart.getTime() + dayOffset * DAY_MS);
    const dow = date.getDay();
    const slots = preferredSlotsFor(dow);
    for (const slot of slots) {
      const candidate = new Date(date);
      candidate.setHours(slot.hour, slot.minute, 0, 0);
      if (candidate.getTime() < Date.now()) continue;
      if (isWorkHours(candidate)) continue;
      const start = candidate.getTime();
      const end = start + durationMinutes * 60 * 1000;
      if (overlaps(start, end, localBusy)) continue;
      // Enforce minimum rest gap from any already-placed session
      const tooClose = placed.some(
        (p) => Math.abs(p.getTime() - start) < MIN_GAP_HOURS * 60 * 60 * 1000,
      );
      if (tooClose) continue;
      localBusy.push({ start, end });
      return candidate;
    }
    return null;
  };

  // Build the day search order: ideal pattern first, then nearby neighbours
  // for anything that can't be placed on its ideal day.
  const ideal = SPREAD_PATTERNS[n] ?? [];
  const remaining = ideal.slice();

  // Pass 1: place each ideal day in order
  for (const day of ideal) {
    if (placed.length >= n) break;
    const slot = tryDayWithSlot(day);
    if (slot) {
      placed.push(slot);
      const idx = remaining.indexOf(day);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  // Pass 2: for each missing slot, try every other day in the week, picking
  // the one that maximises the minimum gap to already-placed sessions.
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  while (placed.length < n) {
    let bestDay = -1;
    let bestGap = -1;
    for (const day of allDays) {
      // Skip days whose date is already used by a placed session.
      const dayDate = new Date(weekStart.getTime() + day * DAY_MS);
      const used = placed.some(
        (p) => p.toDateString() === dayDate.toDateString(),
      );
      if (used) continue;
      // Compute the min gap (in days) this day would have to placed days.
      const minDayGap = placed.length === 0
        ? Infinity
        : Math.min(
            ...placed.map((p) => {
              const pIdx = Math.floor((p.getTime() - weekStart.getTime()) / DAY_MS);
              return Math.abs(pIdx - day);
            }),
          );
      if (minDayGap > bestGap) {
        bestGap = minDayGap;
        bestDay = day;
      }
    }
    if (bestDay < 0) break;
    const slot = tryDayWithSlot(bestDay);
    if (slot) placed.push(slot);
    else {
      // No slot available on the best day; remove it from consideration
      // by adjusting allDays. Simple bail-out: try any remaining day greedily.
      let fallbackPlaced = false;
      for (const day of allDays) {
        if (day === bestDay) continue;
        const slot2 = tryDayWithSlot(day);
        if (slot2) {
          placed.push(slot2);
          fallbackPlaced = true;
          break;
        }
      }
      if (!fallbackPlaced) break;
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
