import type { Task } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

function formatDue(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TaskList({ tasks, onToggle, onRemove }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="card text-center text-sm text-slate-500">
        No tasks yet. Add your first one above.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <li
          key={task.id}
          className={`card flex items-start gap-3 ${
            task.status === "completed" ? "opacity-60" : ""
          }`}
        >
          <input
            type="checkbox"
            className="mt-1"
            checked={task.status === "completed"}
            onChange={() => onToggle(task.id)}
            aria-label={`Mark ${task.title} ${
              task.status === "completed" ? "incomplete" : "complete"
            }`}
          />

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`font-medium ${
                  task.status === "completed" ? "line-through" : ""
                }`}
              >
                {task.title}
              </span>
              <ThemeBadge theme={task.theme} />
              {task.isBlocker && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                  blocker
                </span>
              )}
              {task.privacy !== "public" && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {task.privacy}
                </span>
              )}
            </div>
            {task.description && (
              <p className="mt-1 text-sm text-slate-600">{task.description}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Due {formatDue(task.dueDate)} · {task.urgency} urgency ·{" "}
              {task.estimatedMinutes ?? 30} min · {task.recurrence}
            </p>
          </div>

          <button
            type="button"
            onClick={() => onRemove(task.id)}
            className="text-xs text-slate-400 hover:text-red-600"
            aria-label={`Delete ${task.title}`}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
