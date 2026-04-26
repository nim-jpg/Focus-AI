import { useEffect, useMemo, useState } from "react";
import type { Task, UserPrefs } from "@/types/task";
import { deleteEvent, fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import { busyWindowsForWeek, suggestSessionTimes } from "@/lib/autoSchedule";
import { ThemeBadge } from "./ThemeBadge";

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
  /** Optional: hour grid bounds (defaults to 6-23 if not passed). */
  gridStartHour?: number;
  gridEndHour?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_HEIGHT = 28; // pixels per hour

function startOfWeek(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  const day = (c.getDay() + 6) % 7;
  c.setDate(c.getDate() - day);
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
  gridStartHour = 6,
  gridEndHour = 23,
}: Props) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weekStartDate, setWeekStartDate] = useState<Date>(() =>
    startOfWeek(new Date()),
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

    const dayIdxFor = (d: Date) =>
      Math.floor((d.getTime() - weekStart.getTime()) / DAY_MS);
    const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

    for (const ev of events) {
      if (!ev.start) continue;
      const sd = new Date(ev.start);
      const ed = ev.end ? new Date(ev.end) : new Date(sd.getTime() + 60 * 60 * 1000);
      const dayIdx = dayIdxFor(sd);
      if (dayIdx < 0 || dayIdx > 6) continue;
      out.push({
        kind: "event",
        dayIdx,
        startMin: ev.allDay ? 0 : minutesOf(sd),
        endMin: ev.allDay ? 24 * 60 : minutesOf(ed),
        event: ev,
        allDay: ev.allDay,
      });
    }

    for (const t of tasks) {
      if (t.status === "completed") continue;
      if (t.recurrence === "daily") continue;
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
  }, [events, tasks, weekStart]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIdx = Math.floor((today.getTime() - weekStart.getTime()) / DAY_MS);

  const pendingMultiSession = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status !== "completed" &&
          (t.sessionsPerWeek ?? 0) > 0 &&
          (t.sessionTimes?.length ?? 0) < (t.sessionsPerWeek ?? 0),
      ),
    [tasks],
  );

  const autoScheduleSessionsFor = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !task.sessionsPerWeek) return;
    const need = task.sessionsPerWeek - (task.sessionTimes?.length ?? 0);
    if (need <= 0) return;
    const busy = busyWindowsForWeek(weekStart, weekEnd, tasks, events, taskId);
    const slots = suggestSessionTimes(
      need,
      task.estimatedMinutes ?? 60,
      weekStart,
      busy,
      prefs,
    );
    if (slots.length === 0) return;
    const next = [
      ...(task.sessionTimes ?? []),
      ...slots.map((d) => d.toISOString()),
    ];
    onSetSessionTimes(taskId, next);
  };

  const goPrev = () =>
    setWeekStartDate(new Date(weekStart.getTime() - 7 * DAY_MS));
  const goNext = () =>
    setWeekStartDate(new Date(weekStart.getTime() + 7 * DAY_MS));
  const goToday = () => setWeekStartDate(startOfWeek(new Date()));

  const totalHours = gridEndHour - gridStartHour;
  const gridHeight = totalHours * HOUR_HEIGHT;
  const minToY = (min: number) =>
    ((min - gridStartHour * 60) / 60) * HOUR_HEIGHT;

  // Drag-to-reschedule: native HTML5 drag, no third-party deps.
  // We snap drops to 15-minute intervals.
  const SNAP_MIN = 15;

  type DragPayload =
    | { kind: "task"; taskId: string }
    | { kind: "session"; taskId: string; iso: string };

  const [dragging, setDragging] = useState<DragPayload | null>(null);

  const handleDragStart =
    (payload: DragPayload) => (e: React.DragEvent<HTMLDivElement>) => {
      setDragging(payload);
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require setData to start a drag.
      e.dataTransfer.setData("text/plain", JSON.stringify(payload));
    };

  const handleDragEnd = () => setDragging(null);

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
          <p className="text-xs text-slate-500">
            {calendarConnected
              ? "Hour-positioned grid: Google events (blue), scheduled tasks (green), sessions (violet)."
              : "Connect Calendar (header) to overlay your real events."}
            {error && (
              <span className="ml-2 text-amber-700">· error: {error}</span>
            )}
          </p>
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
            Multi-session tasks need slots this week:
          </p>
          <ul className="mt-1 space-y-1">
            {pendingMultiSession.map((t) => {
              const have = t.sessionTimes?.length ?? 0;
              const need = (t.sessionsPerWeek ?? 0) - have;
              return (
                <li key={t.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-amber-900">
                    {t.title}{" "}
                    <span className="text-amber-700">
                      ({have}/{t.sessionsPerWeek} scheduled)
                    </span>
                  </span>
                  <button
                    type="button"
                    className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-amber-900 hover:border-amber-500"
                    onClick={() => autoScheduleSessionsFor(t.id)}
                  >
                    Auto-schedule {need}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto">
      {/* Day headers */}
      <div
        className="grid border-b border-slate-200 text-xs"
        style={{
          gridTemplateColumns: `48px repeat(7, minmax(110px, 1fr))`,
          minWidth: "820px",
        }}
      >
        <div />
        {DAY_LABELS.map((label, idx) => {
          const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
          const isToday = idx === todayIdx;
          return (
            <div
              key={label}
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
          {DAY_LABELS.map((_, idx) => {
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
        {DAY_LABELS.map((_, dayIdx) => {
          const isToday = dayIdx === todayIdx;
          const dayBlocks = timedBlocks.filter((b) => b.dayIdx === dayIdx);
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
              {/* Working-hours tint */}
              {isWorkingDayIdx(dayIdx) &&
                workTopY < gridHeight &&
                workBottomY > 0 && (
                  <div
                    className="absolute left-0 right-0 bg-slate-100/60"
                    style={{
                      top: `${Math.max(0, workTopY)}px`,
                      height: `${Math.max(0, Math.min(gridHeight, workBottomY) - Math.max(0, workTopY))}px`,
                    }}
                    title="Working hours"
                  />
                )}

              {/* Hour gridlines */}
              {Array.from({ length: totalHours }).map((_, i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 border-t border-dashed border-slate-100"
                  style={{ top: `${i * HOUR_HEIGHT}px` }}
                />
              ))}

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
                const height = Math.max(
                  16,
                  minToY(b.endMin) - minToY(b.startMin),
                );
                const colour =
                  b.kind === "event"
                    ? "border-blue-300 bg-blue-100/90 text-blue-900"
                    : b.kind === "session"
                    ? "border-violet-300 bg-violet-100/90 text-violet-900"
                    : "border-emerald-300 bg-emerald-100/90 text-emerald-900";
                const title =
                  b.event?.summary ??
                  (b.task?.title
                    ? `${b.task.title}${b.kind === "session" ? ` (${b.sessionIdx}/${b.sessionTotal})` : ""}`
                    : "");
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
                return (
                  <div
                    key={i}
                    className={`absolute left-0.5 right-0.5 z-10 overflow-hidden rounded border px-1 py-0.5 text-[10px] leading-tight ${colour} ${
                      draggable ? "cursor-move" : ""
                    }`}
                    style={{ top: `${top}px`, height: `${height}px` }}
                    title={
                      draggable
                        ? `${title} — drag to a new time`
                        : title
                    }
                    {...dragHandlers}
                  >
                    <div className="font-mono text-[9px] opacity-70">
                      {fmtTime(
                        new Date(
                          weekStart.getTime() +
                            b.dayIdx * DAY_MS +
                            b.startMin * 60 * 1000,
                        ).toISOString(),
                      )}
                    </div>
                    <div className="truncate">{title}</div>
                    {b.task && height >= 36 && (
                      <div className="mt-0.5 flex items-center gap-1">
                        <ThemeBadge theme={b.task.theme} />
                      </div>
                    )}
                    {b.task && height >= 28 && (
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
                    {b.event && height >= 28 && (
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
