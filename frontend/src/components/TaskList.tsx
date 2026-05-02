import { useEffect, useMemo, useState } from "react";
import { THEMES, type Task, type Theme, type UserType } from "@/types/task";
import { ThemeBadge } from "./ThemeBadge";
import { isInWorkMode } from "@/lib/modeFilter";

interface Props {
  tasks: Task[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit?: (id: string) => void;
  onUnsnooze?: (id: string) => void;
  onSchedule?: (id: string) => void;
  /** Optional AI ranking — when present unlocks the "AI sort" option. */
  aiTierById?: Map<string, 1 | 2 | 3 | 4>;
  /** Mode toggle from the header — filters the list by work / personal bucket. */
  mode?: "both" | "work" | "personal";
  userType?: UserType;
  /** Google event ids the user has muted — imported tasks linked to those
   *  events drop out of the list entirely (mirrors the Top Three / matrix
   *  behaviour: ignore once, gone everywhere). */
  ignoredEventIds?: string[];
  /** Refresh-AI hook — when supplied, the toolbar shows a Refresh AI button
   *  so the user can re-rank from this tab too. */
  onRefreshAi?: () => void;
  aiBusy?: boolean;
  /** Bumps each time an AI refresh completes — when it changes, the
   *  TaskList auto-switches its sort to AI rank so the user immediately
   *  sees the new ranking applied. */
  aiRefreshTick?: number;
}

type StatusFilter = "open" | "all" | "completed" | "snoozed";
type SortKey = "added" | "ai" | "due" | "urgency";

const THEME_LABELS: Record<Theme, string> = {
  work: "Work",
  projects: "Projects",
  personal: "Personal",
  school: "School",
  fitness: "Fitness",
  finance: "Finance",
  diet: "Diet",
  medication: "Meds",
  development: "Dev",
  household: "Household",
};

function formatDue(iso?: string, includeTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (includeTime) {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

export function TaskList({
  tasks,
  onToggle,
  onRemove,
  onEdit,
  onUnsnooze,
  onSchedule,
  aiTierById,
  mode = "both",
  userType,
  ignoredEventIds = [],
  onRefreshAi,
  aiBusy = false,
  aiRefreshTick = 0,
}: Props) {
  const ignoredEventIdSet = useMemo(
    () => new Set(ignoredEventIds),
    [ignoredEventIds],
  );
  const now = Date.now();
  const [selectedThemes, setSelectedThemes] = useState<Set<Theme>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [sortKey, setSortKey] = useState<SortKey>(
    aiTierById && aiTierById.size > 0 ? "ai" : "added",
  );
  // When an AI refresh completes (aiRefreshTick increments), auto-switch
  // the sort to AI rank so the user immediately sees the fresh ranking.
  useEffect(() => {
    if (aiRefreshTick > 0) setSortKey("ai");
  }, [aiRefreshTick]);

  // Compute counts per theme for the chips (only over the un-themed-filtered set
  // so "School (3)" always shows the true number when nothing is filtered).
  const themeCounts = useMemo(() => {
    const map: Partial<Record<Theme, number>> = {};
    for (const t of tasks) map[t.theme] = (map[t.theme] ?? 0) + 1;
    return map;
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = tasks.filter((t) => {
      if (
        t.calendarEventId &&
        ignoredEventIdSet.has(t.calendarEventId)
      ) {
        return false;
      }
      if (selectedThemes.size > 0 && !selectedThemes.has(t.theme)) return false;
      if (statusFilter === "open" && t.status === "completed") return false;
      if (statusFilter === "completed" && t.status !== "completed") return false;
      if (statusFilter === "snoozed") {
        if (!t.snoozedUntil) return false;
        if (new Date(t.snoozedUntil).getTime() <= now) return false;
      }
      // Header mode toggle (Both / work-bucket / Personal) applies here too.
      if (mode !== "both") {
        const isWorkBucket = isInWorkMode(t, userType);
        if (mode === "work" && !isWorkBucket) return false;
        if (mode === "personal" && isWorkBucket) return false;
      }
      if (q) {
        const hay = `${t.title} ${t.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const URGENCY_ORDER: Record<string, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };
    const cmp = (a: Task, b: Task): number => {
      switch (sortKey) {
        case "ai": {
          const ta = aiTierById?.get(a.id) ?? 5;
          const tb = aiTierById?.get(b.id) ?? 5;
          if (ta !== tb) return ta - tb;
          // Within tier, fall back to most-recently-added.
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        case "due": {
          const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
          const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
          return da - db;
        }
        case "urgency": {
          const ua = URGENCY_ORDER[a.urgency] ?? 4;
          const ub = URGENCY_ORDER[b.urgency] ?? 4;
          if (ua !== ub) return ua - ub;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        case "added":
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    };
    return [...list].sort(cmp);
  }, [tasks, selectedThemes, search, statusFilter, now, sortKey, aiTierById, mode, userType, ignoredEventIdSet]);

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
          {(selectedThemes.size > 0 || search || statusFilter !== "open") && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-slate-500 hover:text-slate-900"
            >
              clear filters
            </button>
          )}
          {onRefreshAi && (
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={onRefreshAi}
              disabled={aiBusy || tasks.length === 0}
              title={
                aiTierById && aiTierById.size > 0
                  ? "Re-rank any new or changed tasks (existing ranks preserved)"
                  : "Ask Claude to rank your tasks"
              }
            >
              {aiBusy ? "Asking Claude…" : "Refresh AI"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {([
              { value: "open", label: "Open" },
              { value: "all", label: "All" },
              { value: "completed", label: "Completed" },
              { value: "snoozed", label: "Snoozed" },
            ] as Array<{ value: StatusFilter; label: string }>).map((opt) => {
              const active = statusFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setStatusFilter(opt.value)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    active
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1 text-xs text-slate-500">
            <span>Sort:</span>
            <select
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              title={
                aiTierById && aiTierById.size > 0
                  ? "AI sort uses Claude's cached tiers from the Today view"
                  : "Refresh AI on the Today view to enable AI sort"
              }
            >
              <option value="added">Last added</option>
              <option
                value="ai"
                disabled={!aiTierById || aiTierById.size === 0}
              >
                AI rank{aiTierById && aiTierById.size > 0 ? "" : " (run AI first)"}
              </option>
              <option value="due">Due date</option>
              <option value="urgency">Urgency</option>
            </select>
          </div>
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
                  {/* Companies-House tasks (statutory filings) get TWO
                      dates surfaced — the statutory deadline (dueDate,
                      hard) and the planned schedule date (scheduledFor,
                      when you'll actually do it). Other tasks show one
                      date as before. */}
                  {task.companyHouseNumber && task.dueDate ? (
                    <>
                      <span className="font-semibold text-rose-700">
                        Deadline {formatDue(task.dueDate, false)}
                      </span>
                      {" · "}
                      {task.scheduledFor ? (
                        <span className="font-medium text-emerald-700">
                          Scheduled {formatDue(task.scheduledFor, true)}
                        </span>
                      ) : (
                        <span className="font-medium text-amber-700">
                          No schedule date — pick one →
                        </span>
                      )}
                      {" · "}
                      {task.urgency} · {task.estimatedMinutes ?? 30} min
                    </>
                  ) : (
                    <>
                      {task.calendarEventId ? "When " : "Due "}
                      {formatDue(task.dueDate, Boolean(task.calendarEventId))} ·{" "}
                      {task.urgency} urgency · {task.estimatedMinutes ?? 30} min ·{" "}
                      {task.recurrence}
                    </>
                  )}
                </p>
              </div>

              <div className="flex w-24 flex-none flex-col gap-1 text-xs">
                {onSchedule && task.status !== "completed" && (
                  <button
                    type="button"
                    onClick={() => onSchedule(task.id)}
                    className="btn-secondary w-full px-2 py-0.5 text-xs"
                    aria-label={
                      task.calendarEventId
                        ? `Re-schedule ${task.title}`
                        : `Schedule ${task.title}`
                    }
                    title={
                      task.calendarEventId
                        ? "Already on Google Calendar — click to move it to a new time"
                        : "Pick a time / push to Calendar"
                    }
                  >
                    {task.calendarEventId ? "Re-schedule" : "Schedule"}
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
                {task.calendarEventId ? (
                  // Imported tasks can't be deleted from Focus3 — the
                  // source of truth is Google. Direct the user there.
                  <a
                    href="https://calendar.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-400 hover:text-slate-700"
                    title="This task is linked to a Google Calendar event. Delete it in Google Calendar — Focus3 will drop the task on the next sync."
                  >
                    Open in Google
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => onRemove(task.id)}
                    className="text-slate-400 hover:text-red-600"
                    aria-label={`Delete ${task.title}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
