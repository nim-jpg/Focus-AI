import type { Task } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  onComplete: (id: string) => void;
  onReschedule: (id: string) => void;
  onSnooze: (id: string, untilIso: string) => void;
}

/**
 * Decide whether a task counts as "slipped":
 *  - Not completed
 *  - Not currently snoozed (snoozedUntil > now hides it)
 *  - Has a scheduledFor (or dueDate, if not scheduled) in the past
 *  - Recurrence is "none", "quarterly", or "yearly"
 *
 * Daily / weekly / monthly recurring tasks are excluded — missing one
 * dose of medication or one workout naturally slides into tomorrow's
 * routine; surfacing every miss would be noisy. Quarterly+ filings
 * (VAT, accounts) DO get flagged because missing them is costly.
 */
export function findSlippedTasks(tasks: Task[], now: Date = new Date()): Task[] {
  const t = now.getTime();
  return tasks.filter((task) => {
    if (task.status === "completed") return false;
    if (task.snoozedUntil && new Date(task.snoozedUntil).getTime() > t) {
      return false;
    }
    const recur = task.recurrence;
    if (recur !== "none" && recur !== "quarterly" && recur !== "yearly") {
      return false;
    }
    const target = task.scheduledFor ?? task.dueDate;
    if (!target) return false;
    return new Date(target).getTime() < t;
  });
}

const SNOOZE_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "Tomorrow", days: 1 },
  { label: "3 days", days: 3 },
  { label: "Next week", days: 7 },
];

function formatRelativePast(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) {
    const hrs = Math.floor(ms / 3600000);
    return hrs <= 1 ? "an hour ago" : `${hrs}h ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function SlippedTasks({
  tasks,
  onComplete,
  onReschedule,
  onSnooze,
}: Props) {
  if (tasks.length === 0) return null;
  return (
    <section className="mb-3 rounded-lg border border-amber-300 bg-gradient-to-r from-amber-50 to-amber-50/40 p-3 text-sm shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-medium text-amber-900">
          {tasks.length} task{tasks.length === 1 ? "" : "s"} slipped — was
          scheduled in the past, not done yet
        </p>
        <span className="text-[11px] text-amber-800">
          Recurring habits aren't shown here; quarterly + yearly filings are.
        </span>
      </div>
      <ul className="space-y-1.5">
        {tasks.map((t) => {
          const target = t.scheduledFor ?? t.dueDate ?? "";
          return (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-800">{t.title}</span>
                  <ThemeBadge theme={t.theme} />
                  <span className="text-xs text-amber-700">
                    slipped {formatRelativePast(target)}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <button
                  type="button"
                  className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-800 hover:border-emerald-500"
                  onClick={() => onComplete(t.id)}
                >
                  Done
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-slate-700 hover:border-slate-500"
                  onClick={() => onReschedule(t.id)}
                >
                  Re-schedule
                </button>
                {SNOOZE_OPTIONS.map((s) => (
                  <button
                    key={s.days}
                    type="button"
                    className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600 hover:border-slate-400"
                    onClick={() => {
                      const until = new Date();
                      until.setDate(until.getDate() + s.days);
                      onSnooze(t.id, until.toISOString());
                    }}
                  >
                    Snooze {s.label}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
