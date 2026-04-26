import { useEffect, useState } from "react";
import type { Task } from "@/types/task";
import { TimeField } from "./TimeField";

export interface ScheduleChoice {
  start: Date;
  end: Date;
  destination: "google" | "local";
  /** Push as a weekly-recurring Google Calendar series (only meaningful
   *  when destination === "google"). */
  weeklyRecurring?: boolean;
}

interface Props {
  task: Task;
  calendarConnected: boolean;
  /** Sensible default start (e.g. next round hour). */
  defaultStart?: Date;
  onConfirm: (choice: ScheduleChoice) => void;
  onCancel: () => void;
  /** Optional: open the task editor (for amending title/dueDate/etc. before
   *  scheduling). Closes the picker on click. */
  onEdit?: (taskId: string) => void;
}

/**
 * Next sensible scheduling slot:
 *  - the next round hour
 *  - but never before 9am or after 7pm (out-of-hours rolls to 9am next day)
 */
function nextSensibleSlot(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  if (d.getHours() < 9) {
    d.setHours(9);
  } else if (d.getHours() >= 19) {
    d.setDate(d.getDate() + 1);
    d.setHours(9);
  }
  return d;
}

function toLocalDateInput(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toLocalTimeInput(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function SchedulePicker({
  task,
  calendarConnected,
  defaultStart,
  onConfirm,
  onCancel,
  onEdit,
}: Props) {
  // Default to caller's defaultStart, else the task's existing scheduledFor
  // (so re-scheduling starts from where it currently lives), else next slot.
  const initial =
    defaultStart ??
    (task.scheduledFor ? new Date(task.scheduledFor) : nextSensibleSlot());
  const [date, setDate] = useState(toLocalDateInput(initial));
  const [time, setTime] = useState(toLocalTimeInput(initial));
  const [duration, setDuration] = useState(task.estimatedMinutes ?? 30);
  const [destination, setDestination] = useState<"google" | "local">(
    calendarConnected ? "google" : "local",
  );
  const [weeklyRecurring, setWeeklyRecurring] = useState(false);

  // Trap Esc to cancel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleConfirm = () => {
    const [h, m] = time.split(":").map(Number);
    const start = new Date(`${date}T00:00:00`);
    start.setHours(h ?? 0, m ?? 0, 0, 0);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    onConfirm({
      start,
      end,
      destination,
      weeklyRecurring: destination === "google" ? weeklyRecurring : false,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h3 className="text-base font-semibold">
            {task.scheduledFor || task.calendarEventId
              ? "Re-schedule this task"
              : "Schedule this task"}
          </h3>
          <p className="text-sm text-slate-600">{task.title}</p>
          {(task.scheduledFor || task.calendarEventId) && (
            <p className="mt-1 text-xs text-slate-500">
              Currently scheduled for{" "}
              <span className="font-medium text-slate-700">
                {task.scheduledFor
                  ? new Date(task.scheduledFor).toLocaleString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "Google Calendar"}
              </span>
              {" — pick a new time below."}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-700">Date</label>
            <input
              type="date"
              className="input mt-1"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-700">Start time</label>
            <TimeField value={time} onChange={setTime} />
          </div>
          <div className="col-span-2">
            <label className="text-xs font-medium text-slate-700">
              Duration <span className="text-slate-400">(minutes)</span>
            </label>
            <input
              type="number"
              min={5}
              step={5}
              className="input mt-1"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value) || 30)}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="text-xs font-medium text-slate-700">Where</label>
          <div className="mt-1 flex flex-wrap gap-2 text-sm">
            <button
              type="button"
              onClick={() => setDestination("local")}
              className={`rounded-full border px-3 py-1 ${
                destination === "local"
                  ? "border-slate-800 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              Schedule locally (in Focus3)
            </button>
            <button
              type="button"
              onClick={() => setDestination("google")}
              disabled={!calendarConnected}
              className={`rounded-full border px-3 py-1 ${
                destination === "google"
                  ? "border-emerald-700 bg-emerald-700 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              title={
                calendarConnected
                  ? "Push as a real Google Calendar event"
                  : "Connect Google Calendar in the header to enable"
              }
            >
              Push to Google Calendar
            </button>
          </div>
          {destination === "google" && (
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={weeklyRecurring}
                onChange={(e) => setWeeklyRecurring(e.target.checked)}
              />
              Repeat weekly (creates a Google Calendar series — RRULE)
            </label>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          {onEdit ? (
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-slate-900"
              onClick={() => onEdit(task.id)}
              title="Open the task editor (closes this picker)"
            >
              Edit task…
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={handleConfirm}>
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
