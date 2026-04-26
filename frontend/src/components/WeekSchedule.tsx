import { useEffect, useMemo, useState } from "react";
import type { Task, UserPrefs } from "@/types/task";
import { deleteEvent, fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import { busyWindowsForWeek, suggestSessionTimesDetailed } from "@/lib/autoSchedule";
import { isDueNow } from "@/lib/recurrence";

interface Props {
  tasks: Task[];
  prefs: UserPrefs;
  calendarConnected: boolean;
  onScheduleClick: (taskId: string) => void;
  onUnschedule: (taskId: string) => void;
  onSetSessionTimes: (taskId: string, isoTimes: string[]) => void;
  /** Move a task's scheduledFor to a new ISO timestamp. */
  onMoveTask: (taskId: string, newIso: string) => void;
  /** Move a session within a task to a new ISO timestamp. */
  onMoveSession: (taskId: string, oldIso: string, newIso: string) => void;
  /** "Block my time too": import a Google event as a local Focus3 task. */
  onShadowEvent: (event: CalendarEvent) => void;
  /** Persist a UserPrefs change (used to remember view-day selection and to
   *  push event-ignore / colour-override updates). */
  onUpdatePrefs?: (patch: Partial<UserPrefs>) => void;
  /** Re-push a task whose Google event has gone missing — clears the stale
   *  calendarEventId and creates a fresh event at the same scheduled time. */
  onRepushToGoogle?: (taskId: string) => Promise<void> | void;
  /** Surface a status message in the page-level banner (e.g. when
   *  auto-schedule finds no slots). */
  onMessage?: (msg: string) => void;
  /** Optional: hour grid bounds (defaults to 6-23 if not passed). */
  gridStartHour?: number;
  gridEndHour?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_HEIGHT = 28; // pixels per hour

/**
 * The visible 7-day window now anchors on TODAY (not Monday). Past is past —
 * the planner's job is to focus the user forward. Prev/next still page by 7
 * days from wherever the anchor is.
 */
function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function fmtTime(iso: string | null, allDay = false): string {
  if (!iso) return "";
  if (allDay) return "all day";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface Block {
  kind: "event" | "task" | "session";
  /** Set on task blocks where the linked Google event has gone missing. */
  brokenLink?: boolean;
  /** True for shadow events (per-event, per-series, or per-calendar). */
  shadow?: boolean;
  dayIdx: number;
  startMin: number; // minutes from midnight
  endMin: number;
  event?: CalendarEvent;
  task?: Task;
  sessionIdx?: number;
  sessionTotal?: number;
  allDay?: boolean;
  /** ISO of the specific session/task instance, used for "remove" actions. */
  instanceIso?: string;
  /** Layout column index within its overlap cluster (0-based). */
  layoutCol?: number;
  /** Total columns in this block's overlap cluster. */
  layoutCols?: number;
  /** Position within its own column (0=top). Used for cascading indent. */
  layoutStackIdx?: number;
  /** True when the user has muted this event (single or via its series),
   *  but it's being shown anyway because Show ignored is on. */
  ignored?: boolean;
  /** Why it was ignored — drives the unignore action target. */
  ignoredVia?: "event" | "series";
}

/**
 * Cascade-indent layout for overlapping blocks. Events that overlap each
 * keep close-to-full width but later starts shift right by a fixed indent,
 * so each block leaves a visible "tab" of the one underneath. Z-order
 * follows start time (earlier = below, later = on top), so the leftmost
 * sliver of every earlier block is always reachable for hover/click.
 */
function layoutOverlappingBlocks(blocks: Block[]): { blocks: Block[] } {
  if (blocks.length === 0) return { blocks: [] };
  const sorted = [...blocks].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin;
  });
  const out: Block[] = [];
  let cluster: Block[] = [];
  let clusterEnd = -1;

  const finalize = () => {
    if (cluster.length === 0) return;
    const total = cluster.length;
    cluster.forEach((b, idx) => {
      b.layoutCol = idx;
      b.layoutStackIdx = idx;
      b.layoutCols = total;
    });
    out.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };

  for (const b of sorted) {
    if (cluster.length > 0 && b.startMin < clusterEnd) {
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, b.endMin);
    } else {
      finalize();
      cluster.push(b);
      clusterEnd = b.endMin;
    }
  }
  finalize();
  return { blocks: out };
}

export function WeekSchedule({
  tasks,
  prefs,
  calendarConnected,
  onScheduleClick,
  onUnschedule,
  onSetSessionTimes,
  onMoveTask,
  onMoveSession,
  onShadowEvent,
  onUpdatePrefs,
  onRepushToGoogle,
  onMessage,
  gridStartHour = 6,
  gridEndHour = 23,
}: Props) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weekStartDate, setWeekStartDate] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [viewDays, setViewDays] = useState<1 | 3 | 7>(
    prefs.homeViewDays ?? 7,
  );
  const [showIgnored, setShowIgnored] = useState(false);
  // Cursor focus: when the user hovers a time slot in a day column, blocks
  // overlapping that slot stay sharp; everything else fades.
  // - When hovering OVER a block: focus = the block's full time range
  //   (so the block stays prominent across its whole duration, not only
  //   where the cursor's Y maps to its true minute — short events with
  //   the 56px minHeight padding would otherwise lose focus mid-block).
  // - When hovering empty column space: focus = the cursor's mapped minute.
  const [hoverFocus, setHoverFocus] = useState<
    | { dayIdx: number; minute: number; range?: undefined }
    | { dayIdx: number; range: { startMin: number; endMin: number }; minute?: undefined }
    | null
  >(null);
  // Three view modes:
  //   "all"     — current grid: every visible event in the chosen calendars
  //   "focus"   — grid filtered to primary calendar + Focus3 tasks/sessions/broken-links
  //   "stacked" — chronological list of every block (no grid; vertical agenda)
  const [viewMode, setViewMode] = useState<"all" | "focus" | "stacked">(
    "all",
  );

  const weekStart = weekStartDate;
  const weekEnd = useMemo(
    () => new Date(weekStart.getTime() + viewDays * DAY_MS),
    [weekStart, viewDays],
  );

  const refresh = async () => {
    if (!calendarConnected) {
      setEvents([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await fetchEvents(weekStart, weekEnd);
      setEvents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarConnected, weekStart.getTime(), viewDays]);

  // Convert events + tasks + sessions into positioned Blocks.
  const blocks: Block[] = useMemo(() => {
    const out: Block[] = [];
    const shadowIds = new Set(prefs.shadowCalendarIds ?? []);
    // Migration: legacy `privateCalendarIds` is folded into the exclude set
    // since "private" is no longer a mode.
    const excludedIds = new Set([
      ...(prefs.excludedCalendarIds ?? []),
      ...(prefs.privateCalendarIds ?? []),
    ]);
    const ignoredEventIds = new Set(prefs.ignoredEventIds ?? []);
    const ignoredSeriesIds = new Set(prefs.ignoredSeriesIds ?? []);
    const shadowedEventIds = new Set(prefs.shadowedEventIds ?? []);
    const shadowedSeriesIds = new Set(prefs.shadowedSeriesIds ?? []);
    const colorOverrides = prefs.calendarColorOverrides ?? {};

    // Tasks linked to Google events (calendarEventId set) — we'll skip rendering
    // them as task blocks because the event itself will appear via the events
    // fetch and we'll annotate it with task metadata instead.
    const tasksByEventId = new Map<string, Task>();
    for (const t of tasks) {
      if (t.calendarEventId && t.calendarEventId !== "set") {
        tasksByEventId.set(t.calendarEventId, t);
      }
    }

    const dayIdxFor = (d: Date) =>
      Math.floor((d.getTime() - weekStart.getTime()) / DAY_MS);
    const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

    for (const ev of events) {
      if (!ev.start) continue;
      // Excluded calendars: don't render at all.
      if (ev.calendarId && excludedIds.has(ev.calendarId)) continue;
      const seriesIgnored = !!(
        ev.recurringEventId && ignoredSeriesIds.has(ev.recurringEventId)
      );
      const instanceIgnored = !!(ev.id && ignoredEventIds.has(ev.id));
      const isIgnored = seriesIgnored || instanceIgnored;
      // When Show ignored is OFF, ignored events are filtered out entirely.
      // When ON, they're rendered with a faded style + an unignore action.
      if (isIgnored && !showIgnored) continue;
      const sd = new Date(ev.start);
      const ed = ev.end ? new Date(ev.end) : new Date(sd.getTime() + 60 * 60 * 1000);
      const dayIdx = dayIdxFor(sd);
      if (dayIdx < 0 || dayIdx >= viewDays) continue;

      // Per-event / per-series shadow overrides any non-shadow calendar.
      const eventShadow =
        (ev.id && shadowedEventIds.has(ev.id)) ||
        (ev.recurringEventId && shadowedSeriesIds.has(ev.recurringEventId));
      const isShadow =
        eventShadow ||
        (ev.calendarId ? shadowIds.has(ev.calendarId) : false);
      const linkedTask = ev.id ? tasksByEventId.get(ev.id) : undefined;
      // User colour override beats Google's calendar colour.
      const overriddenColor = ev.calendarId
        ? colorOverrides[ev.calendarId]
        : undefined;

      const renderedEvent: CalendarEvent = isShadow
        ? {
            ...ev,
            // Faint colour so shadow events read as background context.
            calendarColor: "#cbd5e1", // slate-300
          }
        : overriddenColor
        ? { ...ev, calendarColor: overriddenColor }
        : ev;

      out.push({
        kind: "event",
        dayIdx,
        startMin: ev.allDay ? 0 : minutesOf(sd),
        endMin: ev.allDay ? 24 * 60 : minutesOf(ed),
        event: renderedEvent,
        allDay: ev.allDay,
        // Annotate with the linked task so the block can show "✓ in Google" etc.
        task: linkedTask,
        ignored: isIgnored,
        ignoredVia: seriesIgnored ? "series" : instanceIgnored ? "event" : undefined,
        shadow: isShadow,
      });
    }

    for (const t of tasks) {
      if (t.status === "completed") continue;
      if (t.recurrence === "daily") continue;
      // Skip tasks that have a corresponding Google event — the event renders them.
      if (t.calendarEventId && t.calendarEventId !== "set") {
        // Stale-event check happens later as a separate marker.
        const linkedEvent = events.find((e) => e.id === t.calendarEventId);
        if (linkedEvent) continue;
        // The task references a Google event but the event isn't in this week's
        // fetch — could be moved out of the visible window or deleted. Render
        // a "removed from Google" marker at the originally-scheduled time.
        const iso = t.scheduledFor ?? t.dueDate;
        if (!iso) continue;
        const d = new Date(iso);
        const dayIdx = dayIdxFor(d);
        if (dayIdx < 0 || dayIdx >= viewDays) continue;
        const start = minutesOf(d);
        const dur = t.estimatedMinutes ?? 60;
        out.push({
          kind: "task",
          dayIdx,
          startMin: start,
          endMin: start + dur,
          task: { ...t, title: `⚠ ${t.title} (removed from Google)` },
          brokenLink: true,
        });
        continue;
      }
      const dur = (t.estimatedMinutes ?? 60);

      const sessions = t.sessionTimes ?? [];
      if (sessions.length > 0) {
        const sorted = [...sessions]
          .map((iso) => ({ iso, d: new Date(iso) }))
          .sort((a, b) => a.d.getTime() - b.d.getTime());
        sorted.forEach((entry, sIdx) => {
          const dayIdx = dayIdxFor(entry.d);
          if (dayIdx < 0 || dayIdx >= viewDays) return;
          const start = minutesOf(entry.d);
          out.push({
            kind: "session",
            dayIdx,
            startMin: start,
            endMin: start + dur,
            task: t,
            sessionIdx: sIdx + 1,
            sessionTotal: sorted.length,
            instanceIso: entry.iso,
          });
        });
        continue;
      }

      const iso = t.scheduledFor ?? t.dueDate;
      if (!iso) continue;
      const d = new Date(iso);
      const dayIdx = dayIdxFor(d);
      if (dayIdx < 0 || dayIdx >= viewDays) continue;
      const start = minutesOf(d);
      out.push({
        kind: "task",
        dayIdx,
        startMin: start,
        endMin: start + dur,
        task: t,
      });
    }

    return out;
  }, [
    events,
    tasks,
    weekStart,
    viewDays,
    showIgnored,
    prefs.shadowCalendarIds,
    prefs.excludedCalendarIds,
    prefs.privateCalendarIds,
    prefs.ignoredEventIds,
    prefs.ignoredSeriesIds,
    prefs.shadowedEventIds,
    prefs.shadowedSeriesIds,
    prefs.calendarColorOverrides,
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIdx = Math.floor((today.getTime() - weekStart.getTime()) / DAY_MS);

  /**
   * Sessions count for the rolling 7-day window starting now.
   * "X / Y this week" = X sessions falling between now and now + 7d.
   * Past sessions and sessions more than 7 days out don't count, so the
   * counter naturally re-asks the user as the rolling window advances.
   */
  const sessionsInRolling7d = (t: Task, now: Date): number => {
    const start = now.getTime();
    const end = start + 7 * DAY_MS;
    return (t.sessionTimes ?? []).filter((iso) => {
      const ms = new Date(iso).getTime();
      return ms >= start && ms < end;
    }).length;
  };

  // Tasks that should be slotted into the week schedule but aren't:
  //   - multi-session tasks missing slots in the next rolling 7 days
  //   - weekly+ recurring tasks that are due this week and not yet scheduled
  const pendingMultiSession = useMemo(() => {
    const now = new Date();
    return tasks.filter((t) => {
      if (t.status === "completed") return false;
      if (t.recurrence === "daily") return false;
      if ((t.sessionsPerWeek ?? 0) > 0) {
        return sessionsInRolling7d(t, now) < (t.sessionsPerWeek ?? 0);
      }
      if (
        (t.recurrence === "weekly" ||
          t.recurrence === "monthly" ||
          t.recurrence === "quarterly" ||
          t.recurrence === "yearly") &&
        !t.scheduledFor &&
        !t.calendarEventId &&
        isDueNow(t, now)
      ) {
        // Long-cycle filings (yearly accounts, quarterly VAT) often have a
        // dueDate months out — don't nag the user to schedule them now.
        // Only surface when the deadline is actually within the next ~14 days.
        if (t.dueDate) {
          const daysToDue =
            (new Date(t.dueDate).getTime() - now.getTime()) / 86400000;
          if (daysToDue > 14) return false;
        }
        return true;
      }
      return false;
    });
  }, [tasks]);

  const sessionCountFor = (t: Task): number =>
    (t.sessionsPerWeek ?? 0) > 0
      ? Math.max(
          0,
          (t.sessionsPerWeek ?? 0) - sessionsInRolling7d(t, new Date()),
        )
      : 1;

  const autoScheduleSessionsFor = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const need = sessionCountFor(task);
    if (need <= 0) return;
    // Rolling 7-day window starting from today, NOT the visible weekStart
    // (which can be any day if the user is browsing prev/next). Sessions
    // get spread across the next 7 days from now.
    const rollStart = startOfDay(new Date());
    const rollEnd = new Date(rollStart.getTime() + 7 * DAY_MS);
    const busy = busyWindowsForWeek(
      rollStart,
      rollEnd,
      tasks,
      events,
      taskId,
      prefs.shadowCalendarIds ?? [],
      [
        ...(prefs.excludedCalendarIds ?? []),
        ...(prefs.privateCalendarIds ?? []),
      ],
    );
    let result = suggestSessionTimesDetailed(
      need,
      task.estimatedMinutes ?? 60,
      rollStart,
      busy,
      prefs,
    );
    // Fallback: if EVERY non-past attempt was rejected as outside-waking,
    // the user's day-shape window is too narrow. Try a wide-open day
    // (06:00–23:00) so the user gets *some* placements rather than none,
    // and explain in the message that the window was widened.
    let widenedFallback = false;
    if (
      result.slots.length === 0 &&
      result.attempts.length > 0 &&
      result.attempts.every(
        (a) => a.reason === "outside-waking" || a.reason === "past",
      )
    ) {
      const widePrefs = {
        ...prefs,
        wakeUpTime: "05:30",
        bedTime: "23:30",
      };
      result = suggestSessionTimesDetailed(
        need,
        task.estimatedMinutes ?? 60,
        rollStart,
        busy,
        widePrefs,
      );
      widenedFallback = result.slots.length > 0;
    }
    const slots = result.slots;
    if (slots.length === 0) {
      // Build a useful diagnostic from the per-slot attempts.
      const reasonCounts: Record<string, number> = {};
      const conflictTitles = new Set<string>();
      for (const a of result.attempts) {
        reasonCounts[a.reason] = (reasonCounts[a.reason] ?? 0) + 1;
        if (a.reason === "busy" && a.conflict?.label) {
          conflictTitles.add(a.conflict.label);
        }
      }
      const parts: string[] = [];
      if (reasonCounts["work-hours"])
        parts.push(`${reasonCounts["work-hours"]} during your working hours`);
      if (reasonCounts["outside-waking"])
        parts.push(
          `${reasonCounts["outside-waking"]} outside your day window (${result.windowStart}–${result.windowEnd})`,
        );
      if (reasonCounts["busy"])
        parts.push(`${reasonCounts["busy"]} clash with calendar/tasks`);
      if (reasonCounts["rest-gap"])
        parts.push(
          `${reasonCounts["rest-gap"]} too close to another session (16h rest gap)`,
        );
      if (reasonCounts["past"])
        parts.push(`${reasonCounts["past"]} already in the past`);
      const suffix = parts.length > 0 ? ` — tried ${result.attempts.length} slots: ${parts.join(", ")}.` : "";
      const conflictList =
        conflictTitles.size > 0
          ? ` Conflicts include: ${[...conflictTitles].slice(0, 3).join(", ")}.`
          : "";
      const advice = reasonCounts["outside-waking"]
        ? " Widen Wake up / Bedtime in Settings → Day shape to open more slots."
        : " Adjust working hours, mark calendars as Shadow/Exclude, or schedule manually.";
      onMessage?.(
        `Auto-schedule for "${task.title}" found no free slots in the next 7 days.${suffix}${conflictList}${advice}`,
      );
      return;
    }
    if ((task.sessionsPerWeek ?? 0) > 0) {
      const next = [
        ...(task.sessionTimes ?? []),
        ...slots.map((d) => d.toISOString()),
      ];
      onSetSessionTimes(taskId, next);
      const widenedNote = widenedFallback
        ? " (widened your day window to find slots — adjust Settings → Day shape if you want narrower hours.)"
        : "";
      if (slots.length < need) {
        onMessage?.(
          `Auto-schedule placed ${slots.length} of ${need} sessions for "${task.title}".${widenedNote} Run again later or schedule the rest manually.`,
        );
      } else {
        onMessage?.(
          `Auto-schedule placed ${slots.length} session${slots.length === 1 ? "" : "s"} for "${task.title}".${widenedNote}`,
        );
      }
    } else {
      // Single weekly+ task — set scheduledFor instead of using the sessions array.
      onMoveTask(taskId, slots[0]!.toISOString());
      const widenedNote = widenedFallback
        ? " (widened your day window to find a slot.)"
        : "";
      onMessage?.(
        `Scheduled "${task.title}" for ${slots[0]!.toLocaleString()}.${widenedNote}`,
      );
    }
  };

  const goPrev = () =>
    setWeekStartDate(new Date(weekStart.getTime() - viewDays * DAY_MS));
  const goNext = () =>
    setWeekStartDate(new Date(weekStart.getTime() + viewDays * DAY_MS));
  const goToday = () => setWeekStartDate(startOfDay(new Date()));

  const totalHours = gridEndHour - gridStartHour;
  const gridHeight = totalHours * HOUR_HEIGHT;
  const minToY = (min: number) =>
    ((min - gridStartHour * 60) / 60) * HOUR_HEIGHT;

  // Drag-to-reschedule: native HTML5 drag, no third-party deps.
  // We snap drops to 15-minute intervals.
  const SNAP_MIN = 15;
  const EDGE_HOVER_MS = 400; // hold near the edge this long to advance the week
  const ADVANCE_COOLDOWN_MS = 3000; // pause auto-advance after a jump

  type DragPayload =
    | { kind: "task"; taskId: string }
    | { kind: "session"; taskId: string; iso: string };

  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const edgeTimerRef = useState<{ t: ReturnType<typeof setTimeout> | null }>({
    t: null,
  })[0];
  const advancePausedUntilRef = useState<{ ts: number }>({ ts: 0 })[0];

  const handleDragStart =
    (payload: DragPayload) => (e: React.DragEvent<HTMLDivElement>) => {
      setDragging(payload);
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require setData to start a drag.
      e.dataTransfer.setData("text/plain", JSON.stringify(payload));
    };

  const handleDragEnd = () => {
    setDragging(null);
    if (edgeTimerRef.t) {
      clearTimeout(edgeTimerRef.t);
      edgeTimerRef.t = null;
    }
  };

  const armEdgeAdvance = (direction: "prev" | "next") => {
    if (edgeTimerRef.t) return; // already armed
    if (Date.now() < advancePausedUntilRef.ts) return; // cooling down
    edgeTimerRef.t = setTimeout(() => {
      edgeTimerRef.t = null;
      advancePausedUntilRef.ts = Date.now() + ADVANCE_COOLDOWN_MS;
      if (direction === "next") goNext();
      else goPrev();
    }, EDGE_HOVER_MS);
  };

  const cancelEdgeAdvance = () => {
    if (edgeTimerRef.t) {
      clearTimeout(edgeTimerRef.t);
      edgeTimerRef.t = null;
    }
  };

  const handleColumnDrop =
    (dayIdx: number) => (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (!dragging) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const yPx = e.clientY - rect.top;
      const totalMin = (yPx / HOUR_HEIGHT) * 60 + gridStartHour * 60;
      const snapped = Math.max(0, Math.round(totalMin / SNAP_MIN) * SNAP_MIN);
      const dropDate = new Date(weekStart.getTime() + dayIdx * DAY_MS);
      dropDate.setHours(0, 0, 0, 0);
      dropDate.setMinutes(snapped);
      const newIso = dropDate.toISOString();
      if (dragging.kind === "task") onMoveTask(dragging.taskId, newIso);
      else onMoveSession(dragging.taskId, dragging.iso, newIso);
      setDragging(null);
    };

  // Working-hours tint: grey out the user's typical work block per working day.
  const workStartH = parseFloat(prefs.workingHoursStart.split(":")[0]!) +
    parseFloat(prefs.workingHoursStart.split(":")[1] ?? "0") / 60;
  const workEndH = parseFloat(prefs.workingHoursEnd.split(":")[0]!) +
    parseFloat(prefs.workingHoursEnd.split(":")[1] ?? "0") / 60;
  const workTopY = minToY(workStartH * 60);
  const workBottomY = minToY(workEndH * 60);
  const dateIsoFor = (idx: number) =>
    new Date(weekStart.getTime() + idx * DAY_MS).toISOString().slice(0, 10);
  const holidaySet = new Set(prefs.holidayDates ?? []);
  const isHolidayIdx = (idx: number) => holidaySet.has(dateIsoFor(idx));
  const isWorkingDayIdx = (idx: number) => {
    const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
    if (isHolidayIdx(idx)) return false;
    return prefs.workingDays.includes(dayDate.getDay());
  };
  const isOfficeDayIdx = (idx: number) => {
    const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
    if (isHolidayIdx(idx)) return false;
    return (prefs.officeDays ?? []).includes(dayDate.getDay());
  };
  const toggleHoliday = (idx: number) => {
    if (!onUpdatePrefs) return;
    const iso = dateIsoFor(idx);
    const cur = prefs.holidayDates ?? [];
    onUpdatePrefs({
      holidayDates: cur.includes(iso)
        ? cur.filter((d) => d !== iso)
        : [...cur, iso],
    });
  };
  const commuteMin = prefs.commuteMinutes ?? 0;
  const commuteBeforeTopY = minToY(workStartH * 60 - commuteMin);
  const commuteAfterTopY = minToY(workEndH * 60);
  const commuteAfterBottomY = minToY(workEndH * 60 + commuteMin);

  // Current-time indicator (only on today's column)
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const showNowLine =
    todayIdx >= 0 && todayIdx < viewDays && nowMin >= gridStartHour * 60 && nowMin <= gridEndHour * 60;

  // Focus-only filter: keep tasks/sessions, broken links, and events from
  // the primary calendar (or events linked to a Focus3 task). Drop the rest.
  const passesFocusFilter = (b: Block): boolean => {
    if (viewMode !== "focus") return true;
    if (b.kind === "task" || b.kind === "session") return true;
    if (b.brokenLink) return true;
    if (b.event?.calendarPrimary) return true;
    if (b.task) return true; // event linked to a Focus3 task
    return false;
  };
  const visibleBlocks = blocks.filter(passesFocusFilter);
  const allDayBlocks = visibleBlocks.filter((b) => b.allDay);
  const timedBlocks = visibleBlocks.filter((b) => !b.allDay);

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Week schedule</h2>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
            {!calendarConnected && (
              <span>Connect Calendar (Settings) to overlay your real events.</span>
            )}
            {error && <span className="text-amber-700">error: {error}</span>}
            {/* Legend chips */}
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-200" />
              event
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-200" />
              task
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-200" />
              session
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, transparent 0 2px, rgba(100,116,139,0.45) 2px 3px)",
                }}
              />
              working hours
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, transparent 0 2px, rgba(148,163,184,0.55) 2px 3px)",
                }}
              />
              weekend / non-working
            </span>
            {commuteMin > 0 && (
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(45deg, transparent 0 2px, rgba(217,119,6,0.55) 2px 3px)",
                  }}
                />
                commute
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3 bg-rose-400" />
              now
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {/* View-mode selector: full grid / focus-only / stacked agenda. */}
          <div className="inline-flex overflow-hidden rounded border border-slate-200">
            {([
              { v: "all", label: "All" },
              { v: "focus", label: "Focus" },
              { v: "stacked", label: "Stacked" },
            ] as const).map(({ v, label }) => (
              <button
                key={v}
                type="button"
                onClick={() => setViewMode(v)}
                className={`px-2 py-1 ${
                  viewMode === v
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
                title={
                  v === "all"
                    ? "Every visible event"
                    : v === "focus"
                    ? "Primary calendar + Focus3 tasks/sessions/broken-links only"
                    : "Chronological list of all blocks"
                }
              >
                {label}
              </button>
            ))}
          </div>
          {/* 1 / 3 / 7 day view selector. Persists choice via prefs. */}
          <div className="inline-flex overflow-hidden rounded border border-slate-200">
            {([1, 3, 7] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setViewDays(d);
                  onUpdatePrefs?.({ homeViewDays: d });
                }}
                className={`px-2 py-1 ${
                  viewDays === d
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rounded border border-slate-200 px-2 py-1 hover:border-slate-400"
            onClick={goPrev}
          >
            ← prev
          </button>
          <button
            type="button"
            className="rounded border border-slate-200 px-2 py-1 hover:border-slate-400"
            onClick={goToday}
          >
            today
          </button>
          <button
            type="button"
            className="rounded border border-slate-200 px-2 py-1 hover:border-slate-400"
            onClick={goNext}
          >
            next →
          </button>
          {calendarConnected && (
            <button
              type="button"
              className="text-slate-500 hover:text-slate-900"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? "refreshing…" : "refresh"}
            </button>
          )}
          {((prefs.ignoredEventIds?.length ?? 0) > 0 ||
            (prefs.ignoredSeriesIds?.length ?? 0) > 0) && (
            <button
              type="button"
              onClick={() => setShowIgnored((v) => !v)}
              className={`rounded border px-2 py-1 ${
                showIgnored
                  ? "border-amber-400 bg-amber-50 text-amber-800"
                  : "border-slate-200 text-slate-500 hover:border-slate-400"
              }`}
              title="Reveal events you've muted so you can un-ignore them"
            >
              {showIgnored ? "Hide ignored" : "Show ignored"}
            </button>
          )}
        </div>
      </div>

      {pendingMultiSession.length > 0 && (
        <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs">
          <p className="font-medium text-amber-900">
            Suggested for scheduling this week:
          </p>
          <ul className="mt-1 space-y-1">
            {pendingMultiSession.map((t) => {
              const need = sessionCountFor(t);
              const isMulti = (t.sessionsPerWeek ?? 0) > 0;
              const have = sessionsInRolling7d(t, new Date());
              const label = isMulti
                ? `(${have}/${t.sessionsPerWeek} in next 7d)`
                : `(${t.recurrence}, due)`;
              return (
                <li key={t.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-amber-900">
                    {t.title}{" "}
                    <span className="text-amber-700">{label}</span>
                  </span>
                  <button
                    type="button"
                    className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-amber-900 hover:border-amber-500"
                    onClick={() => autoScheduleSessionsFor(t.id)}
                  >
                    Auto-schedule {need > 1 ? need : ""}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="relative overflow-x-auto">
      {/* Edge advance zones — show while dragging, trigger week jump after a hover */}
      {dragging && (
        <>
          <div
            className="pointer-events-auto absolute inset-y-0 left-0 z-30 w-6 bg-gradient-to-r from-slate-300/60 to-transparent"
            onDragEnter={() => armEdgeAdvance("prev")}
            onDragOver={(e) => {
              e.preventDefault();
              armEdgeAdvance("prev");
            }}
            onDragLeave={cancelEdgeAdvance}
            title="Hold here to jump to previous week"
          />
          <div
            className="pointer-events-auto absolute inset-y-0 right-0 z-30 w-6 bg-gradient-to-l from-slate-300/60 to-transparent"
            onDragEnter={() => armEdgeAdvance("next")}
            onDragOver={(e) => {
              e.preventDefault();
              armEdgeAdvance("next");
            }}
            onDragLeave={cancelEdgeAdvance}
            title="Hold here to jump to next week"
          />
        </>
      )}

      {/* Day headers */}
      <div
        className="grid border-b border-slate-200 text-xs"
        style={{
          // Same template in both modes so day columns line up identically
          // when toggling between All / Focus / Stacked.
          gridTemplateColumns: `48px repeat(${viewDays}, minmax(110px, 1fr))`,
          minWidth: "820px",
        }}
      >
        {/* Empty placeholder for the hour gutter — kept in both modes so
            day columns line up across views. */}
        <div />
        {Array.from({ length: viewDays }).map((_, idx) => {
          const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
          const isToday = idx === todayIdx;
          const isHoliday = isHolidayIdx(idx);
          const label = SHORT_DAYS[dayDate.getDay()];
          return (
            <div
              key={idx}
              className={`border-l border-slate-200 px-2 py-1 ${
                isToday ? "bg-emerald-50/50" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <div>
                  <div className="font-semibold text-slate-700">{label}</div>
                  <div className="text-[10px] text-slate-500">
                    {dayDate.toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                    })}
                  </div>
                </div>
                {onUpdatePrefs && (
                  <button
                    type="button"
                    onClick={() => toggleHoliday(idx)}
                    className={`rounded-full border px-1.5 py-0.5 text-[9px] ${
                      isHoliday
                        ? "border-amber-400 bg-amber-100 text-amber-800"
                        : "border-slate-200 text-slate-400 hover:border-amber-300 hover:text-amber-700"
                    }`}
                    title={
                      isHoliday
                        ? "Marked as a holiday — click to unmark"
                        : "Mark as a holiday (skip working-hours shading)"
                    }
                  >
                    {isHoliday ? "✕ holiday" : "+ holiday"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day strip (only renders when there are all-day events) */}
      {allDayBlocks.length > 0 && (
        <div
          className="grid border-b border-slate-200 text-[10px]"
          style={{
            // Same template in both modes so day columns line up identically
          // when toggling between All / Focus / Stacked.
          gridTemplateColumns: `48px repeat(${viewDays}, minmax(110px, 1fr))`,
            minWidth: "820px",
          }}
        >
          <div className="px-1 py-1 text-right text-slate-400">all-day</div>
          {Array.from({ length: viewDays }).map((_, idx) => {
            const dayBlocks = allDayBlocks.filter((b) => b.dayIdx === idx);
            return (
              <div
                key={idx}
                className={`min-h-[18px] border-l border-slate-200 px-1 py-0.5 ${
                  idx === todayIdx ? "bg-emerald-50/50" : ""
                }`}
              >
                {dayBlocks.map((b, i) => (
                  <div
                    key={i}
                    className="truncate rounded bg-blue-100 px-1 text-blue-900"
                    title={b.event?.summary}
                  >
                    {b.event?.summary}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Hour grid (column-flex stack in stacked mode) */}
      <div
        className="relative grid"
        style={{
          // Same template in both modes so day columns line up identically
          // when toggling between All / Focus / Stacked.
          gridTemplateColumns: `48px repeat(${viewDays}, minmax(110px, 1fr))`,
          minWidth: "820px",
          ...(viewMode === "stacked"
            ? { minHeight: "120px" }
            : { height: `${gridHeight}px` }),
        }}
      >
        {/* Hour labels column — empty placeholder in stacked mode so the
            day columns line up with the All / Focus views. */}
        {viewMode === "stacked" ? (
          <div />
        ) : (
          <div className="relative">
            {Array.from({ length: totalHours }).map((_, i) => {
              const hour = gridStartHour + i;
              return (
                <div
                  key={hour}
                  className="absolute right-1 -translate-y-1.5 text-[10px] text-slate-400"
                  style={{ top: `${i * HOUR_HEIGHT}px` }}
                >
                  {String(hour).padStart(2, "0")}:00
                </div>
              );
            })}
          </div>
        )}

        {/* Day columns */}
        {Array.from({ length: viewDays }).map((_, dayIdx) => {
          const isToday = dayIdx === todayIdx;
          const rawDayBlocks = (
            viewMode === "stacked" ? blocks.filter((b) => b.dayIdx === dayIdx) : timedBlocks.filter((b) => b.dayIdx === dayIdx)
          );
          // Stacked: simple time-sort. Grid: cluster + cascade-indent.
          const dayBlocks = viewMode === "stacked"
            ? [...rawDayBlocks].sort((a, b) => {
                if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
                return a.startMin - b.startMin;
              })
            : layoutOverlappingBlocks(rawDayBlocks).blocks;
          return (
            <div
              key={dayIdx}
              className={`relative border-l border-slate-200 ${
                isToday ? "bg-emerald-50/30" : ""
              } ${dragging ? "ring-1 ring-inset ring-slate-300" : ""} ${
                viewMode === "stacked" ? "flex flex-col gap-1 p-1 min-h-[120px]" : ""
              }`}
              onDragOver={(e) => {
                if (dragging) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={handleColumnDrop(dayIdx)}
              onMouseMove={(e) => {
                if (viewMode === "stacked") return;
                // Only respond when the cursor is over the empty column —
                // when over a block, that block's onMouseEnter sets the
                // focus to its true time range instead.
                if (e.target !== e.currentTarget) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const yPx = e.clientY - rect.top;
                const minute =
                  gridStartHour * 60 + (yPx / HOUR_HEIGHT) * 60;
                // Snap to 15-min granularity to limit re-renders.
                const snapped = Math.round(minute / 15) * 15;
                if (
                  !hoverFocus ||
                  hoverFocus.dayIdx !== dayIdx ||
                  hoverFocus.minute !== snapped
                ) {
                  setHoverFocus({ dayIdx, minute: snapped });
                }
              }}
              onMouseLeave={() => setHoverFocus(null)}
            >
              {/* Working-hours zone — diagonal grey stripes (matches the
                  commute treatment) so it reads as background context, not
                  a solid block. Suppressed on holidays. Skipped in stacked
                  view (no time grid to overlay). */}
              {viewMode !== "stacked" &&
                isWorkingDayIdx(dayIdx) &&
                workTopY < gridHeight &&
                workBottomY > 0 && (
                  <div
                    className="absolute left-0 right-0"
                    style={{
                      top: `${Math.max(0, workTopY)}px`,
                      height: `${Math.max(0, Math.min(gridHeight, workBottomY) - Math.max(0, workTopY))}px`,
                      backgroundImage:
                        "repeating-linear-gradient(45deg, transparent 0 6px, rgba(100,116,139,0.18) 6px 8px)",
                    }}
                    title="Working hours"
                  />
                )}
              {/* Weekend / non-working day — diagonal lighter-grey stripes
                  across the whole column so the user can see at a glance
                  that this day is off-shape. Holidays count too. */}
              {viewMode !== "stacked" &&
                (!isWorkingDayIdx(dayIdx) || isHolidayIdx(dayIdx)) && (
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(45deg, transparent 0 6px, rgba(148,163,184,0.12) 6px 8px)",
                    }}
                    title={
                      isHolidayIdx(dayIdx) ? "Holiday" : "Non-working day"
                    }
                  />
                )}
              {isHolidayIdx(dayIdx) && (
                <div
                  className="pointer-events-none absolute left-1 top-1 z-30 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-800"
                  title="Holiday — working-hours shading is off for this day"
                >
                  holiday
                </div>
              )}
              {/* Commute zones on office days — striped amber so it's distinct.
                  Skipped in stacked view. */}
              {viewMode !== "stacked" && isOfficeDayIdx(dayIdx) && commuteMin > 0 && (
                <>
                  <div
                    className="absolute left-0 right-0 bg-amber-100/70"
                    style={{
                      top: `${Math.max(0, commuteBeforeTopY)}px`,
                      height: `${Math.max(0, workTopY - commuteBeforeTopY)}px`,
                      backgroundImage:
                        "repeating-linear-gradient(45deg, transparent 0 6px, rgba(217,119,6,0.18) 6px 8px)",
                    }}
                    title={`Commute (${commuteMin} min)`}
                  />
                  <div
                    className="absolute left-0 right-0 bg-amber-100/70"
                    style={{
                      top: `${commuteAfterTopY}px`,
                      height: `${Math.max(0, commuteAfterBottomY - commuteAfterTopY)}px`,
                      backgroundImage:
                        "repeating-linear-gradient(45deg, transparent 0 6px, rgba(217,119,6,0.18) 6px 8px)",
                    }}
                    title={`Commute (${commuteMin} min)`}
                  />
                </>
              )}

              {/* Hour gridlines — only in grid mode. */}
              {viewMode !== "stacked" &&
                Array.from({ length: totalHours }).map((_, i) => {
                  const hour = gridStartHour + i;
                  const major = hour % 6 === 0;
                  return (
                    <div
                      key={i}
                      className={`absolute left-0 right-0 border-t ${
                        major ? "border-slate-300" : "border-slate-200"
                      }`}
                      style={{ top: `${i * HOUR_HEIGHT}px` }}
                    />
                  );
                })}

              {/* Now-line on today — grid mode only. */}
              {viewMode !== "stacked" && isToday && showNowLine && (
                <div
                  className="absolute left-0 right-0 z-20 border-t-2 border-rose-400"
                  style={{ top: `${minToY(nowMin)}px` }}
                >
                  <div className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-rose-400" />
                </div>
              )}

              {/* Blocks */}
              {dayBlocks.map((b, i) => {
                const top = Math.max(0, minToY(b.startMin));
                const slotHeight = Math.max(
                  16,
                  minToY(b.endMin) - minToY(b.startMin),
                );
                // Shadow blocks: light grey solid background, medium grey
                // text. Hover deepens the text so it's readable on demand.
                // Non-shadow events use the calendar's solid colour.
                // Sessions / tasks keep their themed solid fill.
                const isShadow = b.shadow ?? false;
                const eventBg = b.event?.calendarColor ?? "#dbeafe";
                const colour =
                  b.kind === "event"
                    ? isShadow
                      ? "bg-slate-100 text-slate-500 border-slate-200 hover:text-slate-900"
                      : "border text-slate-900"
                    : b.kind === "session"
                    ? "border-violet-300 bg-violet-100 text-violet-900"
                    : "border-emerald-300 bg-emerald-100 text-emerald-900";
                const inlineBg =
                  b.kind === "event" && !isShadow
                    ? { backgroundColor: eventBg, borderColor: eventBg }
                    : undefined;
                const title =
                  b.event?.summary ??
                  (b.task?.title
                    ? `${b.task.title}${b.kind === "session" ? ` (${b.sessionIdx}/${b.sessionTotal})` : ""}`
                    : "");
                const startIso = new Date(
                  weekStart.getTime() +
                    b.dayIdx * DAY_MS +
                    b.startMin * 60 * 1000,
                ).toISOString();
                const endIso = new Date(
                  weekStart.getTime() +
                    b.dayIdx * DAY_MS +
                    b.endMin * 60 * 1000,
                ).toISOString();
                const timeRange = `${fmtTime(startIso)} – ${fmtTime(endIso)}`;
                const draggable =
                  b.kind === "task" ||
                  (b.kind === "session" && Boolean(b.instanceIso));
                const dragHandlers = draggable
                  ? {
                      draggable: true,
                      onDragStart: handleDragStart(
                        b.kind === "task"
                          ? { kind: "task", taskId: b.task!.id }
                          : {
                              kind: "session",
                              taskId: b.task!.id,
                              iso: b.instanceIso!,
                            },
                      ),
                      onDragEnd: handleDragEnd,
                    }
                  : {};
                // Cascade-indent layout for overlaps: each later-starting
                // block shifts right by INDENT_PX so a sliver of every
                // earlier block stays visible & clickable. Z-order matches
                // start order (later on top) — hover lifts to the front.
                const INDENT_PX = 14;
                const stackIdx = b.layoutStackIdx ?? 0;
                const leftPx = 1 + stackIdx * INDENT_PX;
                // Block grows tall enough to fit its content by default
                // (start-end + title + theme + actions) regardless of
                // duration. Tall sessions still expand to fill their slot.
                const minHeight = Math.max(slotHeight, 56);

                return (
                  <div
                    key={i}
                    className={`group ${viewMode === "stacked" ? "relative" : "absolute hover:!left-0 hover:!right-0 hover:!w-auto hover:overflow-visible hover:!min-h-fit"} overflow-hidden rounded border px-1 py-0.5 text-[10px] leading-tight transition-all hover:shadow-lg ${colour} ${
                      draggable ? "cursor-move" : ""
                    } ${b.ignored ? "opacity-40 border-dashed" : ""} ${(() => {
                      // Cursor focus: only used in grid mode (stacked
                      // mode shows everything at full opacity).
                      if (viewMode === "stacked") return "";
                      if (!hoverFocus) return "";
                      if (hoverFocus.dayIdx !== b.dayIdx) return "opacity-20";
                      // Range mode (cursor over a block): match if our
                      // time range overlaps the focused range — keeps
                      // the block prominent across its whole duration.
                      if (hoverFocus.range) {
                        const overlap =
                          b.startMin < hoverFocus.range.endMin &&
                          b.endMin > hoverFocus.range.startMin;
                        return overlap ? "" : "opacity-20";
                      }
                      // Minute mode (cursor in empty column space): match
                      // if our time range contains the focused minute.
                      const m = hoverFocus.minute!;
                      const inSlot = m >= b.startMin && m < b.endMin;
                      return inSlot ? "" : "opacity-20";
                    })()}`}
                    style={{
                      // Stacked mode: flex-flow positioning, no absolute Y.
                      // Grid mode: absolute positioning by time.
                      ...(viewMode === "stacked"
                        ? { position: "static" as const }
                        : {
                            top: `${top}px`,
                            minHeight: `${minHeight}px`,
                            left: `${leftPx}px`,
                            right: `1px`,
                            // Later-starting blocks render above earlier
                            // ones so their cascaded body isn't hidden.
                            // Hover bumps to top.
                            zIndex: 10 + stackIdx,
                          }),
                      ...(inlineBg ?? {}),
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.zIndex = "60";
                      // Focus = the block's full time range, so it stays
                      // prominent for the whole duration regardless of
                      // where the cursor lands inside the visual block.
                      setHoverFocus({
                        dayIdx: b.dayIdx,
                        range: { startMin: b.startMin, endMin: b.endMin },
                      });
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.zIndex = String(10 + stackIdx);
                      setHoverFocus(null);
                    }}
                    title={
                      b.event?.calendarName
                        ? `${timeRange} · ${title} · ${b.event.calendarName}`
                        : draggable
                        ? `${timeRange} · ${title} — drag to a new time`
                        : `${timeRange} · ${title}`
                    }
                    {...dragHandlers}
                  >
                    <div className="font-mono text-[9px] opacity-70">
                      {timeRange}
                    </div>
                    <div className="whitespace-normal break-words">
                      {title}
                    </div>
                    {b.task && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px]">
                        {b.kind === "task" && b.task.scheduledFor && (
                          <button
                            type="button"
                            className="hover:underline"
                            onClick={() => onUnschedule(b.task!.id)}
                          >
                            unschedule
                          </button>
                        )}
                        {b.kind === "session" && b.instanceIso && (
                          <button
                            type="button"
                            className="hover:underline"
                            onClick={() => {
                              const remaining = (b.task!.sessionTimes ?? []).filter(
                                (iso) => iso !== b.instanceIso,
                              );
                              onSetSessionTimes(b.task!.id, remaining);
                            }}
                          >
                            remove
                          </button>
                        )}
                        {b.kind !== "session" && (
                          <button
                            type="button"
                            className="hover:underline"
                            onClick={() => onScheduleClick(b.task!.id)}
                          >
                            re-time
                          </button>
                        )}
                        {b.brokenLink && onRepushToGoogle && (
                          <button
                            type="button"
                            className="font-medium text-emerald-700 hover:underline"
                            onClick={() => void onRepushToGoogle(b.task!.id)}
                            title="Create a fresh Google Calendar event at this task's scheduled time and re-link it"
                          >
                            ↻ recreate in Google
                          </button>
                        )}
                      </div>
                    )}
                    {b.event && b.event.calendarName && (
                      <div className="mt-0.5 truncate text-[9px] opacity-80">
                        {b.event.calendarName}
                      </div>
                    )}
                    {b.event && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px]">
                        {b.event.htmlLink && (
                          <a
                            href={b.event.htmlLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            open
                          </a>
                        )}
                        {/* Block my time too — for shadow / awareness events
                            you realise will eat your time. Creates a local
                            Focus3 task at the event's slot. Hidden when the
                            event is already linked to a task. */}
                        {!b.task && (
                          <button
                            type="button"
                            className="hover:underline"
                            onClick={() => b.event && onShadowEvent(b.event)}
                            title="Create a Focus3 block at this time so it counts as busy and shows on the planner"
                          >
                            📌 block my time
                          </button>
                        )}
                        {/* Local ignore — hides the event from Focus3
                            (Google unchanged). Recurring events also offer
                            an "ignore series" action. When Show ignored is
                            ON, the action flips to "unignore". */}
                        {b.event.id && onUpdatePrefs && !b.ignored && (() => {
                          const eid = b.event.id;
                          const sid = b.event.recurringEventId ?? null;
                          const isShadowed =
                            (prefs.shadowedEventIds ?? []).includes(eid) ||
                            !!(sid && (prefs.shadowedSeriesIds ?? []).includes(sid));
                          return (
                            <>
                              {/* Shadow: stays visible (faded), doesn't block. */}
                              {!isShadowed && (
                                <>
                                  <button
                                    type="button"
                                    className="hover:underline"
                                    onClick={() => {
                                      const cur = prefs.shadowedEventIds ?? [];
                                      if (cur.includes(eid)) return;
                                      onUpdatePrefs({
                                        shadowedEventIds: [...cur, eid],
                                      });
                                    }}
                                    title="Show this event greyed in the background — visible but doesn't block scheduling."
                                  >
                                    🌫 shadow
                                  </button>
                                  {sid && (
                                    <button
                                      type="button"
                                      className="hover:underline"
                                      onClick={() => {
                                        const cur =
                                          prefs.shadowedSeriesIds ?? [];
                                        if (cur.includes(sid)) return;
                                        onUpdatePrefs({
                                          shadowedSeriesIds: [...cur, sid],
                                        });
                                      }}
                                      title="Shadow every instance of this recurring series."
                                    >
                                      🌫 series
                                    </button>
                                  )}
                                </>
                              )}
                              {isShadowed && (
                                <button
                                  type="button"
                                  className="text-emerald-700 hover:underline"
                                  onClick={() => {
                                    onUpdatePrefs({
                                      shadowedEventIds: (
                                        prefs.shadowedEventIds ?? []
                                      ).filter((i) => i !== eid),
                                      shadowedSeriesIds: sid
                                        ? (
                                            prefs.shadowedSeriesIds ?? []
                                          ).filter((s) => s !== sid)
                                        : prefs.shadowedSeriesIds ?? [],
                                    });
                                  }}
                                  title="Restore full visibility / blocking for this event."
                                >
                                  ✓ unshadow
                                </button>
                              )}
                              {/* Ignore: hides entirely. */}
                              <button
                                type="button"
                                className="hover:underline"
                                onClick={() => {
                                  const cur = prefs.ignoredEventIds ?? [];
                                  if (cur.includes(eid)) return;
                                  onUpdatePrefs({
                                    ignoredEventIds: [...cur, eid],
                                  });
                                }}
                                title="Hide this single instance from Focus3. Toggle Show ignored to undo."
                              >
                                🚫 ignore
                              </button>
                              {sid && (
                                <button
                                  type="button"
                                  className="hover:underline"
                                  onClick={() => {
                                    const cur = prefs.ignoredSeriesIds ?? [];
                                    if (cur.includes(sid)) return;
                                    onUpdatePrefs({
                                      ignoredSeriesIds: [...cur, sid],
                                    });
                                  }}
                                  title="Hide every instance of this recurring series from Focus3."
                                >
                                  🚫 series
                                </button>
                              )}
                            </>
                          );
                        })()}
                        {b.event.id && onUpdatePrefs && b.ignored && (
                          <button
                            type="button"
                            className="font-medium text-emerald-700 hover:underline"
                            onClick={() => {
                              if (b.ignoredVia === "series" && b.event!.recurringEventId) {
                                onUpdatePrefs({
                                  ignoredSeriesIds: (
                                    prefs.ignoredSeriesIds ?? []
                                  ).filter(
                                    (s) => s !== b.event!.recurringEventId,
                                  ),
                                });
                              } else {
                                onUpdatePrefs({
                                  ignoredEventIds: (
                                    prefs.ignoredEventIds ?? []
                                  ).filter((i) => i !== b.event!.id),
                                });
                              }
                            }}
                            title={
                              b.ignoredVia === "series"
                                ? "Restore the entire recurring series"
                                : "Restore this event"
                            }
                          >
                            ✓ unignore{b.ignoredVia === "series" ? " series" : ""}
                          </button>
                        )}
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={async () => {
                            if (!b.event?.id) return;
                            if (!confirm(`Delete "${b.event.summary}" from Google Calendar?`))
                              return;
                            try {
                              await deleteEvent(b.event.id);
                              await refresh();
                            } catch {
                              // surface error in next refresh; silent here
                            }
                          }}
                        >
                          delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      </div>
    </section>
  );
}
