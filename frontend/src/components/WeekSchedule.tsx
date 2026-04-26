import { useEffect, useMemo, useState } from "react";
import type { Task, UserPrefs } from "@/types/task";
import { deleteEvent, fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import { busyWindowsForWeek, suggestSessionTimes } from "@/lib/autoSchedule";
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
  gridStartHour = 6,
  gridEndHour = 23,
}: Props) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weekStartDate, setWeekStartDate] = useState<Date>(() =>
    startOfDay(new Date()),
  );

  const weekStart = weekStartDate;
  const weekEnd = useMemo(
    () => new Date(weekStart.getTime() + 7 * DAY_MS),
    [weekStart],
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
  }, [calendarConnected, weekStart.getTime()]);

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
      const sd = new Date(ev.start);
      const ed = ev.end ? new Date(ev.end) : new Date(sd.getTime() + 60 * 60 * 1000);
      const dayIdx = dayIdxFor(sd);
      if (dayIdx < 0 || dayIdx > 6) continue;

      const isShadow = ev.calendarId ? shadowIds.has(ev.calendarId) : false;
      const linkedTask = ev.id ? tasksByEventId.get(ev.id) : undefined;

      const renderedEvent: CalendarEvent = isShadow
        ? {
            ...ev,
            // Faint colour so shadow events read as background context.
            calendarColor: "#cbd5e1", // slate-300
          }
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
        if (dayIdx < 0 || dayIdx > 6) continue;
        const start = minutesOf(d);
        const dur = t.estimatedMinutes ?? 60;
        out.push({
          kind: "task",
          dayIdx,
          startMin: start,
          endMin: start + dur,
          task: { ...t, title: `⚠ ${t.title} (removed from Google)` },
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
          if (dayIdx < 0 || dayIdx > 6) return;
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
      if (dayIdx < 0 || dayIdx > 6) continue;
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
    prefs.shadowCalendarIds,
    prefs.excludedCalendarIds,
    prefs.privateCalendarIds,
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIdx = Math.floor((today.getTime() - weekStart.getTime()) / DAY_MS);

  // Tasks that should be slotted into the week schedule but aren't:
  //   - multi-session tasks missing slots
  //   - weekly+ recurring tasks that are due this week and not yet scheduled
  const pendingMultiSession = useMemo(() => {
    const now = new Date();
    return tasks.filter((t) => {
      if (t.status === "completed") return false;
      if (t.recurrence === "daily") return false;
      if ((t.sessionsPerWeek ?? 0) > 0) {
        return (t.sessionTimes?.length ?? 0) < (t.sessionsPerWeek ?? 0);
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
        return true;
      }
      return false;
    });
  }, [tasks]);

  const sessionCountFor = (t: Task): number =>
    (t.sessionsPerWeek ?? 0) > 0
      ? Math.max(0, (t.sessionsPerWeek ?? 0) - (t.sessionTimes?.length ?? 0))
      : 1;

  const autoScheduleSessionsFor = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const need = sessionCountFor(task);
    if (need <= 0) return;
    const busy = busyWindowsForWeek(
      weekStart,
      weekEnd,
      tasks,
      events,
      taskId,
      prefs.shadowCalendarIds ?? [],
      [
        ...(prefs.excludedCalendarIds ?? []),
        ...(prefs.privateCalendarIds ?? []),
      ],
    );
    const slots = suggestSessionTimes(
      need,
      task.estimatedMinutes ?? 60,
      weekStart,
      busy,
      prefs,
    );
    if (slots.length === 0) return;
    if ((task.sessionsPerWeek ?? 0) > 0) {
      const next = [
        ...(task.sessionTimes ?? []),
        ...slots.map((d) => d.toISOString()),
      ];
      onSetSessionTimes(taskId, next);
    } else {
      // Single weekly+ task — set scheduledFor instead of using the sessions array.
      onMoveTask(taskId, slots[0]!.toISOString());
    }
  };

  const goPrev = () =>
    setWeekStartDate(new Date(weekStart.getTime() - 7 * DAY_MS));
  const goNext = () =>
    setWeekStartDate(new Date(weekStart.getTime() + 7 * DAY_MS));
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
  const isWorkingDayIdx = (idx: number) => {
    const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
    return prefs.workingDays.includes(dayDate.getDay());
  };
  const isOfficeDayIdx = (idx: number) => {
    const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
    return (prefs.officeDays ?? []).includes(dayDate.getDay());
  };
  const commuteMin = prefs.commuteMinutes ?? 0;
  const commuteBeforeTopY = minToY(workStartH * 60 - commuteMin);
  const commuteAfterTopY = minToY(workEndH * 60);
  const commuteAfterBottomY = minToY(workEndH * 60 + commuteMin);

  // Current-time indicator (only on today's column)
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const showNowLine =
    todayIdx >= 0 && todayIdx < 7 && nowMin >= gridStartHour * 60 && nowMin <= gridEndHour * 60;

  const allDayBlocks = blocks.filter((b) => b.allDay);
  const timedBlocks = blocks.filter((b) => !b.allDay);

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
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-200" />
              working hours
            </span>
            {commuteMin > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-200" />
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
            this week
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
              const have = t.sessionTimes?.length ?? 0;
              const label = isMulti
                ? `(${have}/${t.sessionsPerWeek} scheduled)`
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
          gridTemplateColumns: `48px repeat(7, minmax(110px, 1fr))`,
          minWidth: "820px",
        }}
      >
        <div />
        {Array.from({ length: 7 }).map((_, idx) => {
          const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
          const isToday = idx === todayIdx;
          const label = SHORT_DAYS[dayDate.getDay()];
          return (
            <div
              key={idx}
              className={`border-l border-slate-200 px-2 py-1 ${
                isToday ? "bg-emerald-50/50" : ""
              }`}
            >
              <div className="font-semibold text-slate-700">{label}</div>
              <div className="text-[10px] text-slate-500">
                {dayDate.toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}
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
            gridTemplateColumns: `48px repeat(7, minmax(110px, 1fr))`,
            minWidth: "820px",
          }}
        >
          <div className="px-1 py-1 text-right text-slate-400">all-day</div>
          {Array.from({ length: 7 }).map((_, idx) => {
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

      {/* Hour grid */}
      <div
        className="relative grid"
        style={{
          gridTemplateColumns: `48px repeat(7, minmax(110px, 1fr))`,
          minWidth: "820px",
          height: `${gridHeight}px`,
        }}
      >
        {/* Hour labels column */}
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

        {/* Day columns */}
        {Array.from({ length: 7 }).map((_, dayIdx) => {
          const isToday = dayIdx === todayIdx;
          const rawDayBlocks = timedBlocks.filter((b) => b.dayIdx === dayIdx);
          // Side-by-side layout for overlapping blocks (Google Calendar style):
          // assign each block a column index within its overlap cluster.
          const layout = layoutOverlappingBlocks(rawDayBlocks);
          const dayBlocks = layout.blocks;
          return (
            <div
              key={dayIdx}
              className={`relative border-l border-slate-200 ${
                isToday ? "bg-emerald-50/30" : ""
              } ${dragging ? "ring-1 ring-inset ring-slate-300" : ""}`}
              onDragOver={(e) => {
                if (dragging) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={handleColumnDrop(dayIdx)}
            >
              {/* Working-hours tint — bolder so it's visible */}
              {isWorkingDayIdx(dayIdx) &&
                workTopY < gridHeight &&
                workBottomY > 0 && (
                  <div
                    className="absolute left-0 right-0 bg-slate-200"
                    style={{
                      top: `${Math.max(0, workTopY)}px`,
                      height: `${Math.max(0, Math.min(gridHeight, workBottomY) - Math.max(0, workTopY))}px`,
                    }}
                    title="Working hours"
                  />
                )}
              {/* Commute zones on office days — striped amber so it's distinct */}
              {isOfficeDayIdx(dayIdx) && commuteMin > 0 && (
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

              {/* Hour gridlines — faint solid lines, slightly stronger every 6 hours */}
              {Array.from({ length: totalHours }).map((_, i) => {
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

              {/* Now-line on today */}
              {isToday && showNowLine && (
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
                // Shadow calendars are rendered as outlined faint blocks
                // (no fill) so they're visible but visually de-emphasised.
                const isShadow = b.event && b.event.calendarId
                  ? (prefs.shadowCalendarIds ?? []).includes(b.event.calendarId)
                  : false;
                const eventBg = b.event?.calendarColor ?? "#dbeafe";
                const colour =
                  b.kind === "event"
                    ? isShadow
                      ? "border-2 border-dashed bg-transparent text-slate-600"
                      : "border text-slate-900"
                    : b.kind === "session"
                    ? "border-violet-300 bg-violet-100/90 text-violet-900"
                    : "border-emerald-300 bg-emerald-100/90 text-emerald-900";
                const inlineBg =
                  b.kind === "event" && !isShadow
                    ? { backgroundColor: eventBg, borderColor: eventBg }
                    : b.kind === "event" && isShadow
                    ? { borderColor: eventBg }
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
                    className={`group absolute overflow-hidden rounded border px-1 py-0.5 text-[10px] leading-tight transition-all hover:!left-0 hover:!right-0 hover:!w-auto hover:overflow-visible hover:!min-h-fit hover:shadow-lg ${colour} ${
                      draggable ? "cursor-move" : ""
                    }`}
                    style={{
                      top: `${top}px`,
                      minHeight: `${minHeight}px`,
                      left: `${leftPx}px`,
                      right: `1px`,
                      // Later-starting blocks render above earlier ones so
                      // their cascaded body isn't hidden. Hover bumps to top.
                      zIndex: 10 + stackIdx,
                      ...(inlineBg ?? {}),
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.zIndex = "60";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.zIndex = String(10 + stackIdx);
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
