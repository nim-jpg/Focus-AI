import type { Task } from "@/types/task";
import { isFoundation } from "@/lib/recurrence";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  onEdit?: (id: string) => void;
}

const HOUR = 60 * 60 * 1000;

function isUrgent(task: Task, now: Date): boolean {
  if (task.urgency === "critical") return true;
  if (!task.dueDate) return false;
  const due = new Date(task.dueDate).getTime();
  if (Number.isNaN(due)) return false;
  const hoursLeft = (due - now.getTime()) / HOUR;
  return hoursLeft <= 48 && hoursLeft >= -24;
}

/** Themes that almost always mean "this matters" — finance, work, projects,
 *  development, school. Used as a positive signal when no other "important"
 *  marker (goal, blocker, urgency) is set. */
const IMPORTANT_THEMES = new Set([
  "work",
  "projects",
  "finance",
  "development",
  "school",
]);

function isImportant(task: Task): boolean {
  if ((task.goalIds ?? []).length > 0) return true;
  if (task.isBlocker) return true;
  if ((task.avoidanceWeeks ?? 0) >= 2) return true;
  if (task.urgency === "high" || task.urgency === "critical") return true;
  // Tasks tied to load-bearing life themes (finance, work, projects, school,
  // dev) get the benefit of the doubt — they shape long-term outcomes even
  // without an explicit goal link.
  if (IMPORTANT_THEMES.has(task.theme)) return true;
  return false;
}

interface Quadrant {
  key: "q1" | "q2" | "q3" | "q4";
  title: string;
  hint: string;
  tasks: Task[];
  classes: string;
}

export function PriorityMatrix({ tasks, onEdit }: Props) {
  const now = new Date();
  const candidates = tasks.filter(
    (t) => t.status !== "completed" && !isFoundation(t),
  );

  const buckets: Record<Quadrant["key"], Task[]> = { q1: [], q2: [], q3: [], q4: [] };
  for (const t of candidates) {
    const u = isUrgent(t, now);
    const i = isImportant(t);
    if (u && i) buckets.q1.push(t);
    else if (!u && i) buckets.q2.push(t);
    else if (u && !i) buckets.q3.push(t);
    else buckets.q4.push(t);
  }

  const quadrants: Quadrant[] = [
    {
      key: "q1",
      title: "Urgent & Important",
      hint: "do now — fires that matter",
      tasks: buckets.q1,
      classes: "border-red-200 bg-red-50/60",
    },
    {
      key: "q2",
      title: "Important, Not Urgent",
      hint: "schedule — long-term wins live here",
      tasks: buckets.q2,
      classes: "border-blue-200 bg-blue-50/60",
    },
    {
      key: "q3",
      title: "Urgent, Not Important",
      hint: "interrupts — delegate, batch, or decline",
      tasks: buckets.q3,
      classes: "border-amber-200 bg-amber-50/60",
    },
    {
      key: "q4",
      title: "Low priority",
      hint: "no deadline pressure or impact signal yet — review weekly",
      tasks: buckets.q4,
      classes: "border-slate-200 bg-slate-50/60",
    },
  ];

  if (candidates.length === 0) {
    return (
      <section>
        <h2 className="mb-2 text-lg font-semibold">Priority matrix</h2>
        <div className="card text-center text-sm text-slate-500">
          Add a few tasks to see them sorted by urgency and importance.
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">Priority matrix</h2>
        <p className="text-xs text-slate-500">
          Urgent × Important. Top-left fires, top-right matters most for the long
          run.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {quadrants.map((q) => (
          <div
            key={q.key}
            className={`rounded-lg border p-3 ${q.classes}`}
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800">{q.title}</h3>
              <span className="text-xs text-slate-500">{q.tasks.length}</span>
            </div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
              {q.hint}
            </p>
            {q.tasks.length === 0 ? (
              <p className="text-xs italic text-slate-400">empty</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {q.tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onEdit?.(t.id)}
                      className="flex items-center gap-1.5 rounded-full border border-white/60 bg-white px-2 py-1 text-xs text-slate-700 shadow-sm hover:border-slate-300"
                      title={onEdit ? "Edit task" : t.title}
                    >
                      <span className="max-w-[14rem] truncate">{t.title}</span>
                      <ThemeBadge theme={t.theme} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
