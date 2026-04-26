import { useEffect, useMemo, useState } from "react";
import type { Task } from "@/types/task";
import { fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  calendarConnected: boolean;
  onScheduleClick: (taskId: string) => void;
  onUnschedule: (taskId: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfWeek(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  // Treat Monday as start of week
  const day = (c.getDay() + 6) % 7; // 0 = Mon
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

interface DayItem {
  kind: "event" | "task";
  start: Date;
  event?: CalendarEvent;
  task?: Task;
}

export function WeekSchedule({
  tasks,
  calendarConnected,
  onScheduleClick,
  onUnschedule,
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

  // Bucket events + scheduled tasks per day-of-week (0=Mon..6=Sun)
  const buckets: DayItem[][] = useMemo(() => {
    const out: DayItem[][] = [[], [], [], [], [], [], []];
    for (const ev of events) {
      if (!ev.start) continue;
      const d = new Date(ev.start);
      const dayIdx = Math.floor((d.getTime() - weekStart.getTime()) / DAY_MS);
      if (dayIdx < 0 || dayIdx > 6) continue;
      out[dayIdx]!.push({ kind: "event", start: d, event: ev });
    }
    for (const t of tasks) {
      if (t.status === "completed") continue;
      const iso = t.scheduledFor ?? t.dueDate;
      if (!iso) continue;
      const d = new Date(iso);
      const dayIdx = Math.floor((d.getTime() - weekStart.getTime()) / DAY_MS);
      if (dayIdx < 0 || dayIdx > 6) continue;
      out[dayIdx]!.push({ kind: "task", start: d, task: t });
    }
    out.forEach((arr) => arr.sort((a, b) => a.start.getTime() - b.start.getTime()));
    return out;
  }, [events, tasks, weekStart]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIdx = Math.floor((today.getTime() - weekStart.getTime()) / DAY_MS);

  const goPrev = () =>
    setWeekStartDate(new Date(weekStart.getTime() - 7 * DAY_MS));
  const goNext = () =>
    setWeekStartDate(new Date(weekStart.getTime() + 7 * DAY_MS));
  const goToday = () => setWeekStartDate(startOfWeek(new Date()));

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Week schedule</h2>
          <p className="text-xs text-slate-500">
            {calendarConnected
              ? "Google Calendar events overlaid with locally-scheduled tasks."
              : "Connect Calendar (header) to see your real events overlaid."}
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

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
        {DAY_LABELS.map((label, idx) => {
          const dayDate = new Date(weekStart.getTime() + idx * DAY_MS);
          const items = buckets[idx]!;
          const isToday = idx === todayIdx;
          return (
            <div
              key={label}
              className={`rounded-md border p-2 ${
                isToday
                  ? "border-emerald-300 bg-emerald-50/40"
                  : "border-slate-200 bg-white"
              }`}
            >
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-slate-700">
                  {label}
                </span>
                <span className="text-[10px] text-slate-500">
                  {dayDate.toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                  })}
                </span>
              </div>
              {items.length === 0 ? (
                <p className="text-[11px] italic text-slate-400">empty</p>
              ) : (
                <ul className="space-y-1">
                  {items.map((it, i) => {
                    if (it.kind === "event" && it.event) {
                      return (
                        <li
                          key={`ev-${it.event.id}-${i}`}
                          className="rounded border border-blue-200 bg-blue-50/70 px-1.5 py-0.5 text-[11px] text-blue-900"
                          title={it.event.summary}
                        >
                          <span className="font-mono">
                            {fmtTime(it.event.start, it.event.allDay)}
                          </span>{" "}
                          <span className="truncate">{it.event.summary}</span>
                        </li>
                      );
                    }
                    if (it.kind === "task" && it.task) {
                      const local = Boolean(it.task.scheduledFor);
                      return (
                        <li
                          key={`t-${it.task.id}-${i}`}
                          className="rounded border border-emerald-200 bg-emerald-50/60 px-1.5 py-0.5 text-[11px] text-emerald-900"
                          title={it.task.title}
                        >
                          <div className="flex items-baseline gap-1">
                            <span className="font-mono">
                              {fmtTime(it.start.toISOString())}
                            </span>
                            <span className="truncate">{it.task.title}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                            <ThemeBadge theme={it.task.theme} />
                            {local && (
                              <button
                                type="button"
                                className="text-emerald-700 hover:underline"
                                onClick={() => onUnschedule(it.task!.id)}
                              >
                                unschedule
                              </button>
                            )}
                            <button
                              type="button"
                              className="text-slate-600 hover:underline"
                              onClick={() => onScheduleClick(it.task!.id)}
                            >
                              re-time
                            </button>
                          </div>
                        </li>
                      );
                    }
                    return null;
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
