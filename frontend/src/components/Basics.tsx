import type { Task } from "@/types/task";
import { wasCompletedToday } from "@/lib/recurrence";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  onComplete: (id: string) => void;
}

export function Basics({ tasks, onComplete }: Props) {
  if (tasks.length === 0) return null;

  const now = new Date();
  const sorted = [...tasks].sort((a, b) => {
    const aDone = wasCompletedToday(a, now);
    const bDone = wasCompletedToday(b, now);
    if (aDone === bDone) return a.title.localeCompare(b.title);
    return aDone ? 1 : -1;
  });

  const doneCount = sorted.filter((t) => wasCompletedToday(t, now)).length;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-700">
            Today&apos;s Basics
          </h2>
          <span className="text-xs text-slate-500">
            foundation — keep the streak quietly
          </span>
        </div>
        <span className="text-xs text-slate-500">
          {doneCount}/{sorted.length} done
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {sorted.map((task) => {
          const done = wasCompletedToday(task, now);
          return (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onComplete(task.id)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                  done
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
                title={done ? "Done today — tap to undo" : "Tap to mark done"}
              >
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
                    done
                      ? "border-emerald-500 bg-emerald-500 text-white"
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
            </li>
          );
        })}
      </ul>
    </section>
  );
}
