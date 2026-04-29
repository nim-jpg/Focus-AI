import type { PrioritizedTask } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  prioritized: PrioritizedTask[];
  onDoEarly: (id: string) => void;
}

export function TomorrowPreview({ prioritized, onDoEarly }: Props) {
  if (prioritized.length === 0) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Tomorrow's preview</h2>
        <span className="text-xs text-slate-500">get ahead — or just know what's coming</span>
      </div>
      <ul className="space-y-2">
        {prioritized.map(({ task, reasoning }) => (
          <li
            key={task.id}
            className="flex items-center justify-between gap-3 rounded-md border border-dashed border-slate-200 bg-slate-50/50 px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium text-slate-700">{task.title}</span>
                <ThemeBadge theme={task.theme} />
              </div>
              <p className="text-xs text-slate-500">{reasoning}</p>
            </div>
            <button
              type="button"
              onClick={() => onDoEarly(task.id)}
              className="btn-secondary text-xs"
              title="Mark done now to free up tomorrow"
            >
              Do early
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
