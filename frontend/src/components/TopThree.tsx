import type { Goal, PrioritizedTask } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  prioritized: PrioritizedTask[];
  onComplete: (id: string) => void;
  onSchedule?: (id: string) => void;
  goals?: Goal[];
}

const TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Must do now",
  2: "Moves you forward",
  3: "Balance",
  4: "Background",
};

const TIER_CLASSES: Record<1 | 2 | 3 | 4, string> = {
  1: "border-red-200 bg-red-50",
  2: "border-blue-200 bg-blue-50",
  3: "border-purple-200 bg-purple-50",
  4: "border-slate-200 bg-slate-50",
};

export function TopThree({ prioritized, onComplete, onSchedule, goals = [] }: Props) {
  const goalById = new Map(goals.map((g) => [g.id, g]));
  if (prioritized.length === 0) {
    return (
      <div className="card text-center text-sm text-slate-500">
        Nothing surfaced yet — add a few tasks and we&apos;ll find your three.
      </div>
    );
  }

  return (
    <ol className="space-y-3">
      {prioritized.map(({ task, tier, reasoning }, idx) => (
        <li
          key={task.id}
          className={`rounded-lg border p-4 shadow-sm ${TIER_CLASSES[tier]}`}
        >
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-white text-sm font-semibold text-slate-700 shadow">
              {idx + 1}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{task.title}</h3>
                <ThemeBadge theme={task.theme} />
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700">
                  Tier {tier} · {TIER_LABELS[tier]}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-700">{reasoning}</p>
              {(task.goalIds ?? []).length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-600">
                  <span className="text-slate-400">ladders up to</span>
                  {(task.goalIds ?? [])
                    .map((id) => goalById.get(id))
                    .filter((g): g is NonNullable<typeof g> => Boolean(g))
                    .map((g) => (
                      <span
                        key={g.id}
                        className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800"
                      >
                        {g.title}
                      </span>
                    ))}
                </div>
              )}
              <p className="mt-1 text-xs text-slate-500">
                {task.estimatedMinutes ?? 30} min ·{" "}
                {task.dueDate
                  ? `due ${new Date(task.dueDate).toLocaleDateString()}`
                  : "no deadline"}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              {onSchedule && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onSchedule(task.id)}
                  title="Schedule on calendar (coming soon)"
                  disabled
                >
                  Schedule
                </button>
              )}
              <button
                type="button"
                className="btn-primary"
                onClick={() => onComplete(task.id)}
              >
                Done
              </button>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
