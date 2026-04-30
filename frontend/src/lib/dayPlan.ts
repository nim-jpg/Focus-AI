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
}): { items: DayItem[]; unscheduled: UnscheduledItem[] } {
  const { day, tasks, foundations, events } = args;
  const items: DayItem[] = [];
  const unscheduled: UnscheduledItem[] = [];

  // Calendar appointments
  for (const ev of events) {
    if (!ev.start || ev.allDay) continue;
    const start = new Date(ev.start);
    if (Number.isNaN(start.getTime())) continue;
    const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 60 * 60_000);
    if (!sameDay(start, day)) continue;
    items.push({
      id: `cal:${ev.id}`,
      source: "calendar",
      fixed: true,
      title: ev.summary || "(no title)",
      start,
      end,
      event: ev,
      accent: ev.calendarColor || "#A78BFA",
      kindGlyph: "📅",
    });
  }

  // Tasks with scheduledFor today (and sessionTimes entries)
  for (const t of tasks) {
    if (t.status === "completed") continue;

    if (t.scheduledFor) {
      const start = new Date(t.scheduledFor);
      if (!Number.isNaN(start.getTime()) && sameDay(start, day)) {
        const dur = (t.estimatedMinutes ?? DEFAULT_TASK_MINUTES) * 60_000;
        const end = new Date(start.getTime() + dur);
        const kind = inferTaskKind(t);
        items.push({
          id: `task:${t.id}`,
          source: "task",
          // If the task is also linked to a Google event, treat that as the
          // source of truth — i.e. fixed. Otherwise it's a Focus3 item that
          // the user can shuffle.
          fixed: !!t.calendarEventId,
          title: t.title,
          start,
          end,
          task: t,
          accent: kind === "follow-up" ? "#A78BFA" : "#10B981",
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
          fixed: !!t.calendarEventId,
          title: `${t.title} · session ${i + 1}`,
          start,
          end: new Date(start.getTime() + dur),
          task: t,
          sessionIndex: i,
          accent: "#A78BFA",
        });
      });
      continue;
    }

    // dueDate today + no scheduledFor → unscheduled bucket
    if (t.dueDate) {
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

  // Foundations with specificTime — render at that time on the target day
  for (const f of foundations) {
    if (f.status === "completed") continue;
    if (f.snoozedUntil && new Date(f.snoozedUntil).getTime() > Date.now()) continue;
    if (!f.specificTime) continue;
    const { h, m } = parseHhmm(f.specificTime, { h: 9, m: 0 });
    const start = new Date(day);
    start.setHours(h, m, 0, 0);
    const dur = (f.estimatedMinutes ?? DEFAULT_FOUNDATION_MINUTES) * 60_000;
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

  // Build "pending" list: movable items whose end is in the past (overdue
  // for today) PLUS the unscheduled bucket. Items that are fixed or already
  // scheduled in the future stay where they are.
  const pending: Array<{ taskId: string; minutes: number; sortKey: number }> = [];
  for (const item of items) {
    if (item.fixed) continue;
    if (item.source === "foundation") continue; // foundations have specific times by design
    if (!item.task) continue;
    if (item.end.getTime() < from.getTime()) {
      const minutes = Math.max(15, Math.round((item.end.getTime() - item.start.getTime()) / 60_000));
      pending.push({
        taskId: item.task.id,
        minutes,
        sortKey: minutes, // largest first
      });
    }
  }
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
