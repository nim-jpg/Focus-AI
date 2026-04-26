import type { Task, UserPrefs } from "@/types/task";
import type { CalendarEvent } from "./googleCalendar";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BusyBlock {
  start: number;
  end: number;
  /** Optional human-readable label so diagnostics can say WHAT blocked a slot. */
  label?: string;
}

interface WorkingHours {
  start: number; // hour 0-24
  end: number;
  days: number[]; // day-of-week 0=Sun..6=Sat
  officeDays: number[];
  commuteHours: number;
  /** Buffer in hours around commute on office days. Slots can't sit within
   *  this many hours of commute start/end. */
  commuteBufferHours: number;
  /** Wake-up hour. Earliest acceptable slot is wakeUp + 0.5 (half hour). */
  wakeUp: number;
  /** Bedtime hour. Latest acceptable slot is bed - 1 (one hour before bed). */
  bed: number;
  /** ISO date strings ("YYYY-MM-DD") the user has marked as holidays —
   *  treated as non-working (no work-hours block, no commute, weekend
   *  slot shape). */
  holidayDates: Set<string>;
}

function parseHour(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) + (m ?? 0) / 60;
}

function workingHoursFromPrefs(prefs?: UserPrefs): WorkingHours {
  return {
    start: prefs ? parseHour(prefs.workingHoursStart) : 9,
    end: prefs ? parseHour(prefs.workingHoursEnd) : 18,
    days: prefs?.workingDays ?? [1, 2, 3, 4, 5],
    officeDays: prefs?.officeDays ?? [],
    commuteHours: (prefs?.commuteMinutes ?? 0) / 60,
    commuteBufferHours: (prefs?.commuteBufferMinutes ?? 30) / 60,
    wakeUp: prefs?.wakeUpTime ? parseHour(prefs.wakeUpTime) : 7,
    bed: prefs?.bedTime ? parseHour(prefs.bedTime) : 23,
    holidayDates: new Set(prefs?.holidayDates ?? []),
  };
}

function isoDateOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isHolidayOf(date: Date, wh: WorkingHours): boolean {
  return wh.holidayDates.has(isoDateOf(date));
}

/** Slot preference rules — weekday-shape vs weekend-shape, anchored to working hours. */
function preferredSlotsFor(
  dayOfWeek: number,
  wh: WorkingHours,
  isHoliday = false,
): Array<{ hour: number; minute: number }> {
  // Holidays use the weekend slot shape (full day available).
  const isWorkingDay = !isHoliday && wh.days.includes(dayOfWeek);
  if (!isWorkingDay) {
    // "weekend" shape: morning slots before any work-anchor
    return [
      { hour: 9, minute: 0 },
      { hour: 10, minute: 30 },
      { hour: 8, minute: 0 },
      { hour: 11, minute: 30 },
    ];
  }
  // Working day: prefer after-work, then early morning before work. Office days
  // push "after work" later to account for commute.
  const isOffice = wh.officeDays.includes(dayOfWeek);
  const afterWork = Math.ceil(wh.end + (isOffice ? wh.commuteHours : 0));
  const earlyMorning = Math.max(
    6,
    Math.floor(wh.start - (isOffice ? wh.commuteHours : 0)) - 1,
  );
  return [
    { hour: afterWork, minute: 0 },
    { hour: afterWork, minute: 30 },
    { hour: Math.min(22, afterWork + 1), minute: 0 },
    { hour: earlyMorning, minute: 0 },
  ];
}

function isWorkHours(date: Date, wh: WorkingHours): boolean {
  if (!wh.days.includes(date.getDay())) return false;
  // Holidays disable the work-hours block for that specific date.
  if (isHolidayOf(date, wh)) return false;
  const t = date.getHours() + date.getMinutes() / 60;
  // On office days, commute + buffer extends busy windows either side.
  const isOffice = wh.officeDays.includes(date.getDay());
  const padding = isOffice ? wh.commuteHours + wh.commuteBufferHours : 0;
  const startBlock = wh.start - padding;
  const endBlock = wh.end + padding;
  return t >= startBlock && t < endBlock;
}

function isOutsideWakingHours(date: Date, wh: WorkingHours): boolean {
  const t = date.getHours() + date.getMinutes() / 60;
  // Earliest = wakeUp + 30 min. Latest start = bed - 1 hour.
  return t < wh.wakeUp + 0.5 || t > wh.bed - 1;
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
export interface SlotAttempt {
  candidate: Date;
  reason: "past" | "work-hours" | "outside-waking" | "busy" | "rest-gap";
  /** When reason === "busy", the busy window that blocked it (start/end ms). */
  conflict?: BusyBlock;
}

export interface SuggestResult {
  slots: Date[];
  /** Per-day attempt log — one entry per slot tried. */
  attempts: SlotAttempt[];
}

export function suggestSessionTimes(
  count: number,
  durationMinutes: number,
  weekStart: Date,
  busy: BusyBlock[],
  prefs?: UserPrefs,
): Date[] {
  return suggestSessionTimesDetailed(
    count,
    durationMinutes,
    weekStart,
    busy,
    prefs,
  ).slots;
}

export function suggestSessionTimesDetailed(
  count: number,
  durationMinutes: number,
  weekStart: Date,
  busy: BusyBlock[],
  prefs?: UserPrefs,
): SuggestResult {
  if (count <= 0) return { slots: [], attempts: [] };
  const n = Math.min(count, 7);
  const wh = workingHoursFromPrefs(prefs);

  const placed: Date[] = [];
  const attempts: SlotAttempt[] = [];
  const localBusy = [...busy];

  const tryDayWithSlot = (dayOffset: number): Date | null => {
    const date = new Date(weekStart.getTime() + dayOffset * DAY_MS);
    const dow = date.getDay();
    const slots = preferredSlotsFor(dow, wh, isHolidayOf(date, wh));
    for (const slot of slots) {
      const candidate = new Date(date);
      candidate.setHours(slot.hour, slot.minute, 0, 0);
      if (candidate.getTime() < Date.now()) {
        attempts.push({ candidate, reason: "past" });
        continue;
      }
      if (isOutsideWakingHours(candidate, wh)) {
        attempts.push({ candidate, reason: "outside-waking" });
        continue;
      }
      if (isWorkHours(candidate, wh)) {
        attempts.push({ candidate, reason: "work-hours" });
        continue;
      }
      const start = candidate.getTime();
      const end = start + durationMinutes * 60 * 1000;
      const conflict = localBusy.find(
        (b) => start < b.end && end > b.start,
      );
      if (conflict) {
        attempts.push({ candidate, reason: "busy", conflict });
        continue;
      }
      const tooClose = placed.some(
        (p) => Math.abs(p.getTime() - start) < MIN_GAP_HOURS * 60 * 60 * 1000,
      );
      if (tooClose) {
        attempts.push({ candidate, reason: "rest-gap" });
        continue;
      }
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

  return {
    slots: placed.sort((a, b) => a.getTime() - b.getTime()),
    attempts,
  };
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
  /** Calendar IDs the user marked as "shadow" — visible but don't block. */
  shadowCalendarIds: string[] = [],
  /** Calendar IDs the user marked as "exclude" — also don't block. */
  excludedCalendarIds: string[] = [],
): BusyBlock[] {
  const busy: BusyBlock[] = [];
  const shadowSet = new Set(shadowCalendarIds);
  const excludedSet = new Set(excludedCalendarIds);

  for (const ev of events) {
    if (!ev.start || !ev.end) continue;
    if (ev.calendarId && shadowSet.has(ev.calendarId)) continue;
    if (ev.calendarId && excludedSet.has(ev.calendarId)) continue;
    const s = new Date(ev.start).getTime();
    const e = new Date(ev.end).getTime();
    if (e < weekStart.getTime() || s > weekEnd.getTime()) continue;
    busy.push({ start: s, end: e, label: ev.summary || "calendar event" });
  }

  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (t.status === "completed") continue;
    const dur = (t.estimatedMinutes ?? 60) * 60 * 1000;
    if (t.scheduledFor) {
      const s = new Date(t.scheduledFor).getTime();
      if (s >= weekStart.getTime() && s < weekEnd.getTime()) {
        busy.push({ start: s, end: s + dur, label: t.title });
      }
    }
    for (const iso of t.sessionTimes ?? []) {
      const s = new Date(iso).getTime();
      if (s >= weekStart.getTime() && s < weekEnd.getTime()) {
        busy.push({ start: s, end: s + dur, label: `${t.title} (session)` });
      }
    }
  }

  return busy;
}
