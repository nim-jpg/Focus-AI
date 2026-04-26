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

function parseHour(hhmm: string | undefined | null): number | null {
  if (!hhmm || typeof hhmm !== "string") return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  return h + (Number.isFinite(m) ? m / 60 : 0);
}

function workingHoursFromPrefs(prefs?: UserPrefs): WorkingHours {
  // Defensive parsing — anything unparseable falls back to a sensible
  // default. Prevents one bad pref value from collapsing the whole
  // candidate-slot window to nothing.
  const start = parseHour(prefs?.workingHoursStart) ?? 9;
  const end = parseHour(prefs?.workingHoursEnd) ?? 18;
  let wakeUp = parseHour(prefs?.wakeUpTime) ?? 7;
  let bed = parseHour(prefs?.bedTime) ?? 23;
  // If wake >= bed (data error), reset to defaults so the candidate
  // window is non-empty.
  if (wakeUp >= bed) {
    wakeUp = 7;
    bed = 23;
  }
  return {
    start,
    end,
    days: prefs?.workingDays ?? [1, 2, 3, 4, 5],
    officeDays: prefs?.officeDays ?? [],
    commuteHours: (prefs?.commuteMinutes ?? 0) / 60,
    commuteBufferHours: (prefs?.commuteBufferMinutes ?? 30) / 60,
    wakeUp,
    bed,
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

/**
 * Generate every legal candidate start time inside the wake → bed window
 * for the given date, in 30-minute steps. Returns them sorted by preference:
 *   - Working day  → evenings (after work end) first, then early-mornings
 *                    (before work start), then anywhere else.
 *   - Weekend / holiday → ascending time (morning first).
 *
 * The slot list IS the wake/bed window — every minute the user is awake is
 * a candidate. work-hours / busy / rest-gap / past filters apply downstream.
 */
function preferredCandidatesFor(
  date: Date,
  wh: WorkingHours,
  isHoliday = false,
): Date[] {
  const dayOfWeek = date.getDay();
  const isWorkingDay = !isHoliday && wh.days.includes(dayOfWeek);
  const STEP_MIN = 30;
  // Walk wake+0.5 → bed-1 in 30-min steps. Round wake to the next 30-min
  // boundary so candidates land on tidy minute values.
  const startMin = Math.ceil((wh.wakeUp + 0.5) * 60 / STEP_MIN) * STEP_MIN;
  const endMin = Math.floor((wh.bed - 1) * 60 / STEP_MIN) * STEP_MIN;
  const out: Date[] = [];
  for (let m = startMin; m <= endMin; m += STEP_MIN) {
    const c = new Date(date);
    c.setHours(Math.floor(m / 60), m % 60, 0, 0);
    out.push(c);
  }
  if (!isWorkingDay) {
    // Already in ascending time order — that's the weekend preference.
    return out;
  }
  // Working day: bucket by relationship to work hours, prefer evenings.
  const workEndH = wh.end;
  const workStartH = wh.start;
  out.sort((a, b) => {
    const ah = a.getHours() + a.getMinutes() / 60;
    const bh = b.getHours() + b.getMinutes() / 60;
    const bucket = (h: number) =>
      h >= workEndH ? 0 : h < workStartH ? 1 : 2;
    const ab = bucket(ah);
    const bb = bucket(bh);
    if (ab !== bb) return ab - bb;
    return a.getTime() - b.getTime();
  });
  return out;
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
  /** Effective day-shape window used (HH:MM strings) — surfaces in
   *  diagnostic messages so the user can see what's being applied. */
  windowStart: string;
  windowEnd: string;
}

function fmtHour(h: number): string {
  const hh = String(Math.floor(h)).padStart(2, "0");
  const mm = String(Math.round((h - Math.floor(h)) * 60)).padStart(2, "0");
  return `${hh}:${mm}`;
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
  const wh = workingHoursFromPrefs(prefs);
  if (count <= 0)
    return {
      slots: [],
      attempts: [],
      windowStart: fmtHour(wh.wakeUp + 0.5),
      windowEnd: fmtHour(wh.bed - 1),
    };
  const n = Math.min(count, 7);

  const placed: Date[] = [];
  const attempts: SlotAttempt[] = [];
  const localBusy = [...busy];

  const tryDayWithSlot = (dayOffset: number): Date | null => {
    const date = new Date(weekStart.getTime() + dayOffset * DAY_MS);
    const candidates = preferredCandidatesFor(date, wh, isHolidayOf(date, wh));
    for (const candidate of candidates) {
      if (candidate.getTime() < Date.now()) {
        attempts.push({ candidate, reason: "past" });
        continue;
      }
      // outside-waking is implicit now: candidates are generated only
      // inside the wake/bed window. Keep the check defensively in case
      // someone passes a custom candidate set later.
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
    windowStart: fmtHour(wh.wakeUp + 0.5),
    windowEnd: fmtHour(wh.bed - 1),
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
  /** Per-event shadow / ignore IDs — visible-but-not-blocking or hidden;
   *  either way the user has said these don't claim their time. */
  shadowedEventIds: string[] = [],
  shadowedSeriesIds: string[] = [],
  ignoredEventIds: string[] = [],
  ignoredSeriesIds: string[] = [],
): BusyBlock[] {
  const busy: BusyBlock[] = [];
  const shadowSet = new Set(shadowCalendarIds);
  const excludedSet = new Set(excludedCalendarIds);
  const shadowEventSet = new Set(shadowedEventIds);
  const shadowSeriesSet = new Set(shadowedSeriesIds);
  const ignoredEventSet = new Set(ignoredEventIds);
  const ignoredSeriesSet = new Set(ignoredSeriesIds);

  for (const ev of events) {
    if (!ev.start || !ev.end) continue;
    if (ev.calendarId && shadowSet.has(ev.calendarId)) continue;
    if (ev.calendarId && excludedSet.has(ev.calendarId)) continue;
    if (ev.id && shadowEventSet.has(ev.id)) continue;
    if (ev.id && ignoredEventSet.has(ev.id)) continue;
    if (ev.recurringEventId && shadowSeriesSet.has(ev.recurringEventId)) continue;
    if (ev.recurringEventId && ignoredSeriesSet.has(ev.recurringEventId)) continue;
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
