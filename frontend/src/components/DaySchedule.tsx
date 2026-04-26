import { useEffect, useMemo, useState } from "react";
import type { Task } from "@/types/task";
import { fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  calendarConnected: boolean;
  /** Push to Google Calendar (uses backend OAuth). */
  onPushToCalendar: (taskId: string) => void;
  /** Schedule locally — sets task.scheduledFor without touching Google. */
  onScheduleLocal: (taskId: string, isoTime: string) => void;
  /** Clear a local schedule. */
  onUnschedule: (taskId: string) => void;
}

interface Row {
  kind: "event" | "task";
  start: Date;
  end?: Date;
  event?: CalendarEvent;
  task?: Task;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function timeLabel(d: Date | undefined, allDay = false): string {
  if (!d) return "—";
  if (allDay) return "all day";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const QUICK_SLOTS = [9, 11, 13, 15, 17, 19];

export function DaySchedule({
  tasks,
  calendarConnected,
  onPushToCalendar,
  onScheduleLocal,
  onUnschedule,
}: Props) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingFor, setPickingFor] = useState<string | null>(null);

  const refresh = async () => {
    if (!calendarConnected) {
      setEvents(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await fetchEvents(startOfToday(), endOfToday());
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
  }, [calendarConnected]);

  // Tasks worth showing today: locally-scheduled today, or due today, or in Top 3 (caller passes prioritized list — for simplicity here we accept all tasks and filter).
  const scheduledToday = useMemo(() => {
    const today = new Date().toDateString();
    return tasks.filter((t) => {
      if (t.status === "completed") return false;
      if (t.scheduledFor && new Date(t.scheduledFor).toDateString() === today) {
        return true;
      }
      if (t.dueDate && new Date(t.dueDate).toDateString() === today) {
        return true;
      }
      return false;
    });
  }, [tasks]);

  const rows: Row[] = useMemo(() => {
    const all: Row[] = [];
    for (const ev of events ?? []) {
      if (!ev.start) continue;
      all.push({
        kind: "event",
        start: new Date(ev.start),
        end: ev.end ? new Date(ev.end) : undefined,
        event: ev,
      });
    }
    for (const t of scheduledToday) {
      const startIso = t.scheduledFor ?? t.dueDate;
      if (!startIso) continue;
      all.push({ kind: "task", start: new Date(startIso), task: t });
    }
    return all.sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [events, scheduledToday]);

  const isEmpty = rows.length === 0 && (events?.length ?? 0) === 0 && scheduledToday.length === 0;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Today's schedule</h2>
          <p className="text-xs text-slate-500">
            {calendarConnected
              ? "Google Calendar events overlaid with your scheduled tasks."
              : "Connect Calendar (header) to overlay your real events here."}
          </p>
        </div>
        {calendarConnected && (
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-900"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "refreshing…" : "refresh"}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Calendar error — {error}
        </div>
      )}

      {isEmpty ? (
        <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-3 text-center text-xs text-slate-500">
          Nothing scheduled today. Pick a task below to slot it in.
        </div>
      ) : (
        <ul className="space-y-1">
          {rows.map((row, idx) => {
            if (row.kind === "event" && row.event) {
              return (
                <li
                  key={`ev-${row.event.id}-${idx}`}
                  className="flex items-center gap-3 rounded-md border border-blue-200 bg-blue-50/60 px-3 py-1.5 text-sm"
                >
                  <span className="w-24 flex-none font-mono text-xs text-blue-900">
                    {timeLabel(row.start, row.event.allDay)}
                    {row.end && !row.event.allDay && ` – ${timeLabel(row.end)}`}
                  </span>
                  <span className="flex-1 text-blue-900">{row.event.summary}</span>
                  {row.event.htmlLink && (
                    <a
                      href={row.event.htmlLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-700 hover:underline"
                    >
                      open
                    </a>
                  )}
                </li>
              );
            }
            if (row.kind === "task" && row.task) {
              const isLocal = Boolean(row.task.scheduledFor);
              return (
                <li
                  key={`t-${row.task.id}-${idx}`}
                  className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-1.5 text-sm"
                >
                  <span className="w-24 flex-none font-mono text-xs text-emerald-900">
                    {timeLabel(row.start)}
                  </span>
                  <span className="flex-1 truncate text-emerald-900">
                    {row.task.title}
                  </span>
                  <ThemeBadge theme={row.task.theme} />
                  {isLocal && (
                    <button
                      type="button"
                      className="text-xs text-emerald-700 hover:underline"
                      onClick={() => onUnschedule(row.task!.id)}
                      title="Remove local schedule"
                    >
                      unschedule
                    </button>
                  )}
                </li>
              );
            }
            return null;
          })}
        </ul>
      )}

      {/* Quick scheduler: lets user slot any non-completed task into today */}
      <div className="mt-3 rounded-md border border-slate-200 bg-white p-2 text-xs">
        <p className="mb-1 font-medium text-slate-700">Slot a task into today</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className="input h-7 py-0 text-xs"
            value={pickingFor ?? ""}
            onChange={(e) => setPickingFor(e.target.value || null)}
          >
            <option value="">choose a task…</option>
            {tasks
              .filter((t) => t.status !== "completed")
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
          {pickingFor && (
            <>
              {QUICK_SLOTS.map((hour) => (
                <button
                  key={hour}
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-2 py-0.5 hover:border-slate-400"
                  onClick={() => {
                    const slot = new Date();
                    slot.setHours(hour, 0, 0, 0);
                    onScheduleLocal(pickingFor, slot.toISOString());
                    setPickingFor(null);
                  }}
                >
                  {hour}:00
                </button>
              ))}
              <button
                type="button"
                className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-800 hover:border-emerald-400"
                onClick={() => {
                  onPushToCalendar(pickingFor);
                  setPickingFor(null);
                }}
                disabled={!calendarConnected}
                title={
                  calendarConnected
                    ? "Create real Google Calendar event"
                    : "Connect Calendar first"
                }
              >
                push to Google
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
