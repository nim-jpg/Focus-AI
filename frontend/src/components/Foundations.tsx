import type { Task, TimeOfDay } from "@/types/task";
import {
  counterCountToday,
  isCounter,
  isOverdueToday,
  wasCompletedToday,
} from "@/lib/recurrence";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  onComplete: (id: string) => void;
  onIncrement: (id: string, delta: number) => void;
  onEdit?: (id: string) => void;
}

const SLOT_ORDER: TimeOfDay[] = ["morning", "midday", "afternoon", "evening", "anytime"];
const SLOT_LABELS: Record<TimeOfDay, string> = {
  morning: "Morning",
  midday: "Midday",
  afternoon: "Afternoon",
  evening: "Evening",
  anytime: "Anytime",
};

function chipClasses(done: boolean, overdue: boolean): string {
  if (done) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (overdue) return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-slate-200 bg-white text-slate-700 hover:border-slate-300";
}

export function Foundations({ tasks, onComplete, onIncrement, onEdit }: Props) {
  if (tasks.length === 0) return null;

  const now = new Date();
  const doneCount = tasks.filter((t) => wasCompletedToday(t, now)).length;

  const grouped = SLOT_ORDER.map((slot) => ({
    slot,
    items: tasks
      .filter((t) => (t.timeOfDay ?? "anytime") === slot)
      .sort((a, b) => {
        const aDone = wasCompletedToday(a, now);
        const bDone = wasCompletedToday(b, now);
        if (aDone === bDone) return a.title.localeCompare(b.title);
        return aDone ? 1 : -1;
      }),
  })).filter((g) => g.items.length > 0);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Foundations</h2>
        <span className="text-xs text-slate-500">
          {doneCount}/{tasks.length} done
        </span>
      </div>
      <div className="space-y-2">
        {grouped.map(({ slot, items }) => (
          <div key={slot} className="flex flex-wrap items-center gap-2">
            <span className="w-20 flex-none text-xs font-medium uppercase tracking-wide text-slate-500">
              {SLOT_LABELS[slot]}
            </span>
            {items.map((task) => {
              const done = wasCompletedToday(task, now);
              const overdue = isOverdueToday(task, now);
              const counter = isCounter(task);
              const count = counter ? counterCountToday(task, now) : 0;
              const target = task.counter?.target ?? 0;

              if (counter) {
                return (
                  <div
                    key={task.id}
                    className={`flex items-center gap-2 rounded-full border px-2 py-1 text-sm ${chipClasses(done, overdue)}`}
                  >
                    <button
                      type="button"
                      onClick={() => onIncrement(task.id, -1)}
                      className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-600 hover:bg-slate-100"
                      aria-label={`Subtract from ${task.title}`}
                      disabled={count === 0}
                    >
                      −
                    </button>
                    <span className="font-medium tabular-nums">
                      {count}/{target}
                    </span>
                    <span className={done ? "line-through opacity-70" : ""}>
                      {task.title}
                    </span>
                    <ThemeBadge theme={task.theme} />
                    <button
                      type="button"
                      onClick={() => onIncrement(task.id, 1)}
                      className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
                      aria-label={`Add to ${task.title}`}
                    >
                      +
                    </button>
                    {onEdit && (
                      <button
                        type="button"
                        onClick={() => onEdit(task.id)}
                        className="text-xs text-slate-400 hover:text-slate-700"
                        aria-label={`Edit ${task.title}`}
                      >
                        ✎
                      </button>
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={task.id}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${chipClasses(done, overdue)}`}
                >
                  <button
                    type="button"
                    onClick={() => onComplete(task.id)}
                    className="flex items-center gap-2"
                    title={done ? "Done today — tap to undo" : "Tap to mark done"}
                  >
                    <span
                      className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
                        done
                          ? "border-emerald-500 bg-emerald-500 text-white"
                          : overdue
                          ? "border-amber-500"
                          : "border-slate-300"
                      }`}
                    >
                      {done ? "✓" : ""}
                    </span>
                    <span className={done ? "line-through opacity-70" : ""}>
                      {task.title}
                    </span>
                    <ThemeBadge theme={task.theme} />
                  </button>
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(task.id)}
                      className="text-xs text-slate-400 hover:text-slate-700"
                      aria-label={`Edit ${task.title}`}
                    >
                      ✎
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
