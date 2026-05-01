import type { Task, UserPrefs } from "@/types/task";
import type { CalendarEvent } from "@/lib/googleCalendar";
import { inferTaskKind } from "@/lib/taskKind";

/**
 * DayItem is the unified shape rendered on the day-timeline brick stack —
 * Google appointments AND Focus3 items, side by side.
 *
 * `fixed` distinguishes the two: appointments come from Google, can't be
 * shoved around from the iOS shell, and stay visible as anchors. Focus3
 * items are movable — the user can ±15 / ±60 them, drag them, or hit
 * Auto-reschedule to flow them into gaps.
 *
 * Time fields are absolute Date objects (not offsets) so layout math is
 * trivial: pixel = (start.getTime() - dayStart.getTime()) / 1000 / 60 * pxPerMin.
 */
export interface DayItem {
  id: string;
  source: "calendar" | "task" | "foundation" | "session";
  /** True for Google appointments — render with a lock, no ± buttons,
   *  not eligible for auto-reschedule. */
  fixed: boolean;
  title: string;
  start: Date;
  end: Date;
  /** Original task/event so the UI can call back with full context. */
  task?: Task;
  event?: CalendarEvent;
  /** For session-times entries — index into the parent task's sessionTimes[]. */
  sessionIndex?: number;
  /** Pre-computed kind glyph hint for fast render. */
  kindGlyph?: string;
  /** Hex color suggestion (calendar color, kind color, etc.). */
  accent?: string;
  /** True if marked complete (only meaningful for task/foundation/session). */
  done?: boolean;
}

/** Tasks that need a slot today but have no scheduledFor yet. Surfaced
 *  above the brick stack as "Needs a slot — auto-reschedule will place". */
export interface UnscheduledItem {
  id: string;
  title: string;
  estimatedMinutes: number;
  task: Task;
}

const DEFAULT_TASK_MINUTES = 30;
const DEFAULT_FOUNDATION_MINUTES = 15;

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Heuristic: does this Google Calendar event look like a meeting or
 * appointment that the user can't unilaterally move? Things involving
 * other people / external venues are "fixed"; everything else (a self-
 * scheduled focus block, a personal reminder) stays movable.
 *
 * Title-based because we don't fetch attendees today. False negatives
 * are fine — the user just gets ± controls on something they could
 * just as well leave alone. False positives are worse — we'd lock a
 * block they need to shift — so the patterns stay opinionated and the
 * default is movable.
 */
export function isLikelyAppointment(ev: CalendarEvent): boolean {
  const title = (ev.summary ?? "").toLowerCase().trim();
  if (!title) return false;
  // Meeting / work-collaboration keywords
  if (
    /\b(meeting|call|sync|stand[- ]?up|review|interview|catch[- ]?up|all[- ]?hands|kick[- ]?off|presentation|demo|workshop|training|webinar|conf|onboarding|retro|1[: -]?on[: -]?1|1[: -]?1)\b/.test(
      title,
    )
  ) {
    return true;
  }
  // Appointment / external commitment keywords
  if (
    /\b(doctor|dentist|gp|clinic|hospital|appointment|appt|surgery|consult|consultation|specialist|therapist|physio|massage|hairdresser|barber|optometrist|optician|class|lesson|tutor|coaching|hearing)\b/.test(
      title,
    )
  ) {
    return true;
  }
  // "with someone" / "w/ name" suggests another person involved
  if (/\b(with|w\/)\s+[a-z]/.test(title)) return true;
  return false;
}

function parseHhmm(s: string | undefined, fallback: { h: number; m: number }): { h: number; m: number } {
  if (!s) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return fallback;
  return { h: Math.max(0, Math.min(23, parseInt(m[1], 10))), m: Math.max(0, Math.min(59, parseInt(m[2], 10))) };
}

/**
 * Collect everything that should appear on the day timeline for a given day.
 * Returns scheduled bricks (with start/end) + unscheduled "needs a slot" items.
 *
 * Sources:
 *  - Google calendar events (always fixed)
 *  - Tasks with scheduledFor on the day (movable unless calendarEventId set)
 *  - Foundations with specificTime today (movable; default duration 15m)
 *  - sessionTimes entries on multi-session tasks falling on this day
 *  - Tasks with dueDate today and no scheduledFor → unscheduled bucket
 */
export function collectDayItems(args: {
  day: Date;
  tasks: Task[];
  foundations: Task[];
  events: CalendarEvent[];
  /** User prefs — needed to honour ignoredEventIds + ignoredSeriesIds (the
   *  desktop "mute / skip series" feature). When omitted nothing is filtered. */
  prefs?: { ignoredEventIds?: string[]; ignoredSeriesIds?: string[] };
}): { items: DayItem[]; unscheduled: UnscheduledItem[] } {
  const { day, tasks, foundations, events, prefs } = args;
  const items: DayItem[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const ignoredEvents = new Set(prefs?.ignoredEventIds ?? []);
  const ignoredSeries = new Set(prefs?.ignoredSeriesIds ?? []);

  // Calendar events — only meetings / external appointments lock as fixed.
  // Self-scheduled focus blocks on the calendar stay movable; the user can
  // shuffle them around like anything else.
  // Items the user has muted on Desktop (whole series or one-off) are
  // skipped so the day plan stays consistent across surfaces.
  for (const ev of events) {
    if (!ev.start || ev.allDay) continue;
    if (ignoredEvents.has(ev.id)) continue;
    if (ev.recurringEventId && ignoredSeries.has(ev.recurringEventId)) continue;
    const start = new Date(ev.start);
    if (Number.isNaN(start.getTime())) continue;
    const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 60 * 60_000);
    if (!sameDay(start, day)) continue;
    const fixed = isLikelyAppointment(ev);
    items.push({
      id: `cal:${ev.id}`,
      source: "calendar",
      fixed,
      title: ev.summary || "(no title)",
      start,
      end,
      event: ev,
      accent: ev.calendarColor || (fixed ? "#94A3B8" : "#A78BFA"),
      // No emoji — LaneCard renders a small inline lock SVG for calendar
      // items based on item.source. Cleaner than 📅 / 🕓.
    });
  }

  // Tasks with scheduledFor today (and sessionTimes entries).
  // Completed tasks STAY visible in the day plan — the tick fills, the
  // glow drops, but the slot remains so the user can see what's
  // already been done. The unscheduled bucket excludes completed
  // (they don't need slotting).
  for (const t of tasks) {
    const done = t.status === "completed";

    if (t.scheduledFor) {
      const start = new Date(t.scheduledFor);
      if (!Number.isNaN(start.getTime()) && sameDay(start, day)) {
        const dur = (t.estimatedMinutes ?? DEFAULT_TASK_MINUTES) * 60_000;
        const end = new Date(start.getTime() + dur);
        const kind = inferTaskKind(t);
        items.push({
          id: `task:${t.id}`,
          source: "task",
          // Tasks ARE the user's own work — even if pushed to Google
          // Calendar, they remain movable. Only events that look like
          // meetings/appointments (handled in the events loop above)
          // get the fixed treatment.
          fixed: false,
          title: t.title,
          start,
          end,
          task: t,
          accent: kind === "follow-up" ? "#A78BFA" : "#10B981",
          done,
        });
        continue;
      }
    }

    // Multi-session tasks: render each session that falls today
    if (t.sessionTimes && t.sessionTimes.length > 0) {
      t.sessionTimes.forEach((iso, i) => {
        const start = new Date(iso);
        if (Number.isNaN(start.getTime()) || !sameDay(start, day)) return;
        const dur = (t.estimatedMinutes ?? DEFAULT_TASK_MINUTES) * 60_000;
        items.push({
          id: `session:${t.id}:${i}`,
          source: "session",
          fixed: false,
          title: `${t.title} · session ${i + 1}`,
          start,
          end: new Date(start.getTime() + dur),
          task: t,
          sessionIndex: i,
          accent: "#A78BFA",
          done,
        });
      });
      continue;
    }

    // dueDate today + no scheduledFor → unscheduled bucket. Completed ones
    // don't need a slot so we skip them here.
    if (!done && t.dueDate) {
      const due = new Date(t.dueDate);
      if (!Number.isNaN(due.getTime()) && sameDay(due, day)) {
        unscheduled.push({
          id: t.id,
          title: t.title,
          estimatedMinutes: t.estimatedMinutes ?? DEFAULT_TASK_MINUTES,
          task: t,
        });
      }
    }
  }

  // Foundations with specificTime — render at that time on the target day.
  // Completed (and completed-counter) foundations stay visible so the user
  // can see their progress; we mark them done so the visual reflects it.
  for (const f of foundations) {
    if (f.snoozedUntil && new Date(f.snoozedUntil).getTime() > Date.now()) continue;
    if (!f.specificTime) continue;
    const { h, m } = parseHhmm(f.specificTime, { h: 9, m: 0 });
    const start = new Date(day);
    start.setHours(h, m, 0, 0);
    const dur = (f.estimatedMinutes ?? DEFAULT_FOUNDATION_MINUTES) * 60_000;
    const counterDone =
      !!f.counter && f.counter.count >= f.counter.target;
    items.push({
      id: `foundation:${f.id}`,
      source: "foundation",
      fixed: false,
      title: f.title,
      start,
      end: new Date(start.getTime() + dur),
      task: f,
      accent: "#F59E0B",
      kindGlyph: "♾",
      done: f.status === "completed" || counterDone,
    });
  }

  // Sort by start, lanes assigned downstream
  items.sort((a, b) => a.start.getTime() - b.start.getTime());
  unscheduled.sort((a, b) => b.estimatedMinutes - a.estimatedMinutes);
  return { items, unscheduled };
}

/**
 * Lane assignment over DayItems — same algorithm as before but operating on
 * the unified shape. Returns map<itemId → lane>. Lower lane = leftward column.
 */
export function assignDayLanes(items: DayItem[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime());
  const laneEnds: number[] = [];
  for (const item of sorted) {
    const start = item.start.getTime();
    const end = item.end.getTime();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    out.set(item.id, lane);
  }
  return out;
}

/**
 * Auto-reschedule pending Focus3 items into the gaps around fixed appointments,
 * starting from `from` (typically NOW) until end-of-working-day.
 *
 * Returns a list of proposed updates: `{ taskId, newScheduledForIso }`. The
 * caller applies them via updateTask — keeps this pure for testability.
 *
 * Strategy:
 *   - "Pending" = movable items whose end-time is in the past (overdue today)
 *                 OR are still in the unscheduled bucket
 *   - Sort fixed items + future-movable items by start, build a list of free
 *     gaps inside [from, workingHoursEnd]
 *   - For each pending item (largest first — fit big stones first), find the
 *     first gap ≥ its duration, place it, advance the gap start
 *   - Items that don't fit are returned as `unplaced` — the UI shows a hint
 *     ("3 didn't fit — push to tomorrow?")
 */
export function autoReschedule(args: {
  day: Date;
  from: Date;
  prefs: UserPrefs;
  items: DayItem[];
  unscheduled: UnscheduledItem[];
}): {
  updates: Array<{ taskId: string; newScheduledForIso: string }>;
  unplaced: Array<{ taskId: string; reason: string }>;
} {
  const { day, from, prefs, items, unscheduled } = args;

  const dayEnd = (() => {
    const { h, m } = parseHhmm(prefs.workingHoursEnd ?? "20:00", { h: 20, m: 0 });
    const out = new Date(day);
    out.setHours(h, m, 0, 0);
    return out;
  })();

  // If we're already past the working-day end, push everything to tomorrow's
  // working-hours-start.
  let cursor = new Date(Math.max(from.getTime(), startOfDay(day).getTime()));
  if (cursor.getTime() >= dayEnd.getTime()) {
    return {
      updates: [],
      unplaced: unscheduled.map((u) => ({
        taskId: u.task.id,
        reason: "after working hours",
      })),
    };
  }

  // Build "pending" list. Crucially we do NOT pull overdue items into this
  // pool — the user's intent is to actually tick those off, not have them
  // silently shuffled forward. They stay where they were so they keep
  // showing up as "still on the list". Only truly-unscheduled items
  // (dueDate today, no slot) get auto-placed into gaps.
  //
  // If the user wants an overdue item moved, the right tool is the ±15/±60
  // shift (with cascade) or marking it deferred / cancelled / done.
  const pending: Array<{ taskId: string; minutes: number; sortKey: number }> = [];
  for (const u of unscheduled) {
    pending.push({ taskId: u.task.id, minutes: u.estimatedMinutes, sortKey: u.estimatedMinutes });
  }
  // Largest first — pack big stones, small stones flow into remaining cracks.
  pending.sort((a, b) => b.sortKey - a.sortKey);

  // Build gaps from cursor → dayEnd, around fixed items + future-movable items.
  // Future-movable items keep their slots — auto-reschedule only fills gaps;
  // it doesn't re-shuffle things you already placed.
  const obstacles: Array<{ start: Date; end: Date }> = [];
  for (const item of items) {
    if (item.end.getTime() <= cursor.getTime()) continue; // already past
    if (!item.fixed && item.source !== "foundation") {
      // Movable items in the future — only treat as obstacles if they're
      // already scheduled (have a slot we don't want to overwrite).
      if (item.task && !item.task.scheduledFor && !item.task.calendarEventId) continue;
    }
    obstacles.push({ start: item.start, end: item.end });
  }
  obstacles.sort((a, b) => a.start.getTime() - b.start.getTime());

  const updates: Array<{ taskId: string; newScheduledForIso: string }> = [];
  const unplaced: Array<{ taskId: string; reason: string }> = [];

  let nextStart = cursor;
  let oi = 0;

  for (const p of pending) {
    while (true) {
      // Skip obstacles that have ended
      while (oi < obstacles.length && obstacles[oi].end.getTime() <= nextStart.getTime()) oi++;
      // Find next obstacle that starts after nextStart
      const nextObstacle = obstacles[oi];
      const slotEnd = nextObstacle ? nextObstacle.start : dayEnd;
      const gapMinutes = Math.floor((slotEnd.getTime() - nextStart.getTime()) / 60_000);
      if (gapMinutes >= p.minutes) {
        // Fits.
        updates.push({ taskId: p.taskId, newScheduledForIso: nextStart.toISOString() });
        nextStart = new Date(nextStart.getTime() + p.minutes * 60_000);
        break;
      } else if (nextObstacle) {
        // Skip past this obstacle and try the next gap.
        nextStart = nextObstacle.end;
        oi++;
      } else {
        // No more obstacles, but the remaining day isn't enough.
        unplaced.push({ taskId: p.taskId, reason: "no gap large enough today" });
        break;
      }
    }
  }

  return { updates, unplaced };
}

/** Round a Date to the nearest 15-min boundary. Keeps everything on a
 *  predictable rhythm — a +15 on a 16:07 item lands on 16:15, not 16:22.
 *  Same applies to cascaded items: they all settle on quarter-hours. */
function snapTo15(date: Date): Date {
  const out = new Date(date);
  const total = out.getHours() * 60 + out.getMinutes();
  const snapped = Math.round(total / 15) * 15;
  out.setHours(0, 0, 0, 0);
  out.setMinutes(snapped, 0, 0);
  return out;
}

/**
 * Cascading shift — moving one item later (or earlier) bumps any movable
 * items that would now overlap with it. Fixed appointments stop the cascade
 * dead: anything booked to a calendar stays where it is. The overlapping
 * movable item gets pushed by the same delta the target moved by.
 *
 * All resulting start times snap to the nearest 15-min boundary so things
 * line up cleanly — 16:00 / 16:15 / 16:30 — instead of drifting (16:07,
 * 16:23, etc.) as misaligned items get adjusted.
 *
 * Pushing earlier (negative delta) does NOT pull subsequent items back —
 * "earlier" creates a gap, but yanking later items into it would surprise
 * the user. Auto-reschedule is the right tool for re-packing.
 *
 * Returns one update per affected item. The caller (App.tsx) applies them
 * via updateTask({ scheduledFor }).
 */
export function cascadeShift(args: {
  items: DayItem[];
  targetItemId: string;
  deltaMin: number;
}): Array<{ taskId: string; newScheduledForIso: string }> {
  const { items, targetItemId, deltaMin } = args;
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime());
  const targetIdx = sorted.findIndex((i) => i.id === targetItemId);
  if (targetIdx === -1) return [];
  const target = sorted[targetIdx];
  if (!target.task || target.fixed) return [];

  const updates: Array<{ taskId: string; newScheduledForIso: string }> = [];

  const targetNewStart = snapTo15(new Date(target.start.getTime() + deltaMin * 60_000));
  // Recompute the "effective" cascade delta from the snapped target so
  // downstream items shift by the same actual offset the user sees.
  const effectiveDeltaMs =
    targetNewStart.getTime() - target.start.getTime();
  const targetNewEnd = new Date(target.end.getTime() + effectiveDeltaMs);
  updates.push({
    taskId: target.task.id,
    newScheduledForIso: targetNewStart.toISOString(),
  });

  if (effectiveDeltaMs > 0) {
    let cursor = targetNewEnd;
    for (let i = targetIdx + 1; i < sorted.length; i++) {
      const item = sorted[i];
      if (item.fixed) break; // hard stop — calendar appointments anchor everything after them
      if (!item.task) continue;
      if (item.start.getTime() >= cursor.getTime()) break; // gap — cascade ends
      const newStart = snapTo15(
        new Date(item.start.getTime() + effectiveDeltaMs),
      );
      updates.push({
        taskId: item.task.id,
        newScheduledForIso: newStart.toISOString(),
      });
      // Use the snapped start to advance the cursor — keeps the
      // overlap check honest in case the snap moved this item back/
      // forward by a few minutes.
      const itemDur = item.end.getTime() - item.start.getTime();
      cursor = new Date(newStart.getTime() + itemDur);
    }
  }

  return updates;
}
