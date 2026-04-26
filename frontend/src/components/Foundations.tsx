import type { Task } from "@/types/task";
import {
  counterCountToday,
  isCounter,
  isOverdueToday,
  streakDays,
  wasCompletedToday,
} from "@/lib/recurrence";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  onComplete: (id: string) => void;
  onIncrement: (id: string, delta: number) => void;
  onEdit?: (id: string) => void;
}

function chipClasses(done: boolean, overdue: boolean): string {
  if (done) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (overdue) return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-slate-200 bg-white text-slate-700 hover:border-slate-300";
}

const SLOT_ORDER: Record<string, number> = {
  morning: 0,
  midday: 1,
  afternoon: 2,
  evening: 3,
  anytime: 4,
};

export function Foundations({ tasks, onComplete, onIncrement, onEdit }: Props) {
  if (tasks.length === 0) return null;

  const now = new Date();
  const doneCount = tasks.filter((t) => wasCompletedToday(t, now)).length;

  // Single-row layout: timed first (chronologically), then by time-of-day slot,
  // done items sink to the right. They're flags, not a daily plan.
  const sorted = [...tasks].sort((a, b) => {
    const aDone = wasCompletedToday(a, now);
    const bDone = wasCompletedToday(b, now);
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aT = a.specificTime ?? "99:99";
    const bT = b.specificTime ?? "99:99";
    if (aT !== bT) return aT.localeCompare(bT);
    const aS = SLOT_ORDER[a.timeOfDay ?? "anytime"] ?? 4;
    const bS = SLOT_ORDER[b.timeOfDay ?? "anytime"] ?? 4;
    if (aS !== bS) return aS - bS;
    return a.title.localeCompare(b.title);
  });

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Foundations</h2>
        <span className="text-xs text-slate-500">
          {doneCount}/{tasks.length} done
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sorted.map((task) => {
              const done = wasCompletedToday(task, now);
              const overdue = isOverdueToday(task, now);
              const counter = isCounter(task);
              const count = counter ? counterCountToday(task, now) : 0;
              const target = task.counter?.target ?? 0;
              const streak = streakDays(task, now);
              const streakBadge = streak >= 2 ? (
                <span
                  className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800"
                  title={`${streak}-day streak`}
                >
                  🔥 {streak}d
                </span>
              ) : null;

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
                    {streakBadge}
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
                  {streakBadge}
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
    </section>
  );
}
