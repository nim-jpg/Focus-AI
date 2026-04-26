import { useMemo, useState } from "react";
import { THEMES, type Task, type Theme } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit?: (id: string) => void;
  onUnsnooze?: (id: string) => void;
  onSchedule?: (id: string) => void;
}

type StatusFilter = "open" | "all" | "completed" | "snoozed";

const THEME_LABELS: Record<Theme, string> = {
  work: "Work",
  personal: "Personal",
  school: "School",
  fitness: "Fitness",
  finance: "Finance",
  diet: "Diet",
  medication: "Meds",
  development: "Dev",
  household: "Household",
};

function formatDue(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TaskList({
  tasks,
  onToggle,
  onRemove,
  onEdit,
  onUnsnooze,
  onSchedule,
}: Props) {
  const now = Date.now();
  const [selectedThemes, setSelectedThemes] = useState<Set<Theme>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");

  // Compute counts per theme for the chips (only over the un-themed-filtered set
  // so "School (3)" always shows the true number when nothing is filtered).
  const themeCounts = useMemo(() => {
    const map: Partial<Record<Theme, number>> = {};
    for (const t of tasks) map[t.theme] = (map[t.theme] ?? 0) + 1;
    return map;
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (selectedThemes.size > 0 && !selectedThemes.has(t.theme)) return false;
      if (statusFilter === "open" && t.status === "completed") return false;
      if (statusFilter === "completed" && t.status !== "completed") return false;
      if (statusFilter === "snoozed") {
        if (!t.snoozedUntil) return false;
        if (new Date(t.snoozedUntil).getTime() <= now) return false;
      }
      if (q) {
        const hay = `${t.title} ${t.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, selectedThemes, search, statusFilter, now]);

  const toggleTheme = (theme: Theme) =>
    setSelectedThemes((prev) => {
      const next = new Set(prev);
      if (next.has(theme)) next.delete(theme);
      else next.add(theme);
      return next;
    });

  const clearAll = () => {
    setSelectedThemes(new Set());
    setSearch("");
    setStatusFilter("open");
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input h-8 flex-1 min-w-[160px] text-sm"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="input h-8 w-auto text-sm"
          >
            <option value="open">Open</option>
            <option value="all">All</option>
            <option value="completed">Completed</option>
            <option value="snoozed">Snoozed</option>
          </select>
          {(selectedThemes.size > 0 || search || statusFilter !== "open") && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-slate-500 hover:text-slate-900"
            >
              clear filters
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {THEMES.map((theme) => {
            const count = themeCounts[theme] ?? 0;
            const active = selectedThemes.has(theme);
            return (
              <button
                key={theme}
                type="button"
                onClick={() => toggleTheme(theme)}
                disabled={count === 0}
                className={`rounded-full border px-2 py-0.5 text-xs transition disabled:opacity-40 ${
                  active
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                }`}
                title={`Filter by ${THEME_LABELS[theme]}`}
              >
                {THEME_LABELS[theme]}
                <span className={active ? "ml-1 opacity-70" : "ml-1 text-slate-400"}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-slate-500">
          Showing {filtered.length} of {tasks.length} task{tasks.length === 1 ? "" : "s"}.
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="card text-center text-sm text-slate-500">
          {tasks.length === 0
            ? "No tasks yet. Add your first one above."
            : "No tasks match those filters."}
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((task) => (
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
                  {task.snoozedUntil && new Date(task.snoozedUntil).getTime() > now && (
                    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-800">
                      snoozed until {new Date(task.snoozedUntil).toLocaleDateString()}
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

              <div className="flex flex-col gap-1 text-xs">
                {onSchedule && task.status !== "completed" && (
                  <button
                    type="button"
                    onClick={() => onSchedule(task.id)}
                    className="text-emerald-700 hover:text-emerald-900"
                    aria-label={`Schedule ${task.title}`}
                    title="Pick a time / push to Calendar"
                  >
                    Schedule
                  </button>
                )}
                {onEdit && (
                  <button
                    type="button"
                    onClick={() => onEdit(task.id)}
                    className="text-slate-500 hover:text-slate-900"
                    aria-label={`Edit ${task.title}`}
                  >
                    Edit
                  </button>
                )}
                {onUnsnooze &&
                  task.snoozedUntil &&
                  new Date(task.snoozedUntil).getTime() > now && (
                    <button
                      type="button"
                      onClick={() => onUnsnooze(task.id)}
                      className="text-indigo-600 hover:text-indigo-800"
                    >
                      Wake
                    </button>
                  )}
                <button
                  type="button"
                  onClick={() => onRemove(task.id)}
                  className="text-slate-400 hover:text-red-600"
                  aria-label={`Delete ${task.title}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
