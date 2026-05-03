import { useMemo, useState } from "react";
import {
  GOAL_HORIZONS,
  MACRO_THEMES,
  MACRO_THEME_LABELS,
  THEMES,
  type Goal,
  type GoalHorizon,
  type MacroTheme,
  type Task,
  type Theme,
} from "@/types/task";
import type { NewGoalInput } from "@/lib/useGoals";
import { ThemeBadge } from "./ThemeBadge";
import { resolveGoalMacroThemes } from "@/lib/themeRouter";

interface Props {
  goals: Goal[];
  /** All open tasks — used to find unlinked candidates for AI suggestion. */
  tasks: Task[];
  taskCountByGoal: Map<string, number>;
  progressByGoal?: Map<
    string,
    { doneLast30: number; lastActivityIso?: string }
  >;
  onAdd: (input: NewGoalInput) => void;
  onUpdate: (id: string, patch: Partial<Goal>) => void;
  onRemove: (id: string) => void;
  /** Open the new-task modal pre-linked to this goal. */
  onAddTaskForGoal?: (goalId: string) => void;
  /** Add the goal id to a task's goalIds (idempotent). */
  onLinkTaskToGoal?: (taskId: string, goalId: string) => void;
  /** Remove the goal id from a task's goalIds. */
  onUnlinkTaskFromGoal?: (taskId: string, goalId: string) => void;
  /** Hide the internal h2 ("Goals") — used when a parent (e.g. IosShell)
   *  is already rendering its own page title for the same view. */
  compact?: boolean;
}

const HORIZON_LABELS: Record<GoalHorizon, string> = {
  "6m": "6 months",
  "1y": "1 year",
  "5y": "5 years",
  "10y": "10 years",
};

const HORIZON_ORDER: GoalHorizon[] = ["6m", "1y", "5y", "10y"];

const blank: NewGoalInput = {
  title: "",
  horizon: "1y",
  theme: "personal",
  notes: "",
  macroThemes: [],
};

function relativeDays(iso?: string): string {
  if (!iso) return "no activity yet";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) return "active today";
  if (days === 1) return "active yesterday";
  if (days < 7) return `active ${days} days ago`;
  if (days < 30) return `active ${Math.floor(days / 7)}w ago`;
  return `quiet for ${Math.floor(days / 30)}mo`;
}

export function Goals({
  goals,
  tasks,
  taskCountByGoal,
  progressByGoal,
  onAdd,
  onUpdate,
  onRemove,
  onAddTaskForGoal,
  onUnlinkTaskFromGoal,
  compact = false,
}: Props) {
  const [draft, setDraft] = useState<NewGoalInput>(blank);
  const [open, setOpen] = useState(false);
  // Goals are compact by default — title, theme, count, activity. Click to
  // reveal notes + linked tasks for the goal you're focusing on. Keeps the
  // page scannable when you have 10+ goals.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Macro filter — pills filter goals by life-bucket (Money / Learning /
  // Stress / Health / Career / Family / Creative / Admin). Independent
  // axis from the Theme enum on tasks; goals get tagged into one or
  // more macros via macroThemes (or auto-resolved from title + theme).
  // null = show every goal.
  const [macroFilter, setMacroFilter] = useState<MacroTheme | null>(null);
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Match-to-goals lives in the centralised SmartActionsBar (top of
  // page, "AI · Smart organise"). The local match state + runMatchAll
  // function used to live here; deleted along with the now-redundant
  // "✨ Match tasks to goals" button.

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) return;
    onAdd({ ...draft, title: draft.title.trim() });
    setDraft(blank);
    setOpen(false);
  };

  // Macro counts: how many goals belong to each macro bucket. A goal
  // can sit in multiple buckets (debt-payoff = Money + Stress), so the
  // counts here CAN sum to more than goals.length — that's intentional.
  const macroCounts = useMemo(() => {
    const map = new Map<MacroTheme, number>();
    for (const g of goals) {
      const macros = resolveGoalMacroThemes(g);
      for (const m of macros) {
        map.set(m, (map.get(m) ?? 0) + 1);
      }
    }
    return map;
  }, [goals]);
  const visibleGoals = macroFilter
    ? goals.filter((g) =>
        resolveGoalMacroThemes(g).includes(macroFilter),
      )
    : goals;

  const grouped = HORIZON_ORDER.map((horizon) => ({
    horizon,
    items: visibleGoals.filter((g) => g.horizon === horizon),
  })).filter((g) => g.items.length > 0);

  // Tasks linked to each goal — used so each goal card can show its current
  // links with an unlink (×) button.
  const tasksByGoal = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.status === "completed") continue;
    for (const gid of t.goalIds ?? []) {
      const arr = tasksByGoal.get(gid) ?? [];
      arr.push(t);
      tasksByGoal.set(gid, arr);
    }
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          {!compact && <h2 className="text-lg font-semibold">Goals</h2>}
          <p className="text-xs text-slate-500">
            What you're working toward. Tasks can ladder up to these.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Cancel" : "Add goal"}
          </button>
          {/* "✨ Match tasks to goals" used to live here. Now centralised
              in the header bar (SmartActionsBar → AI · Smart organise),
              which runs Top-3 re-rank + theme-bucket + AI matcher in
              one click. */}
        </div>
      </div>

      {/* Result banner moved to the SmartActionsBar in the header. */}

      {open && (
        <form onSubmit={handleSubmit} className="card mb-3 space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-700">Title</label>
            <input
              className="input mt-1"
              placeholder="e.g. Pay off £30k debt"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-slate-700">Horizon</label>
              <select
                className="input mt-1"
                value={draft.horizon}
                onChange={(e) =>
                  setDraft({ ...draft, horizon: e.target.value as GoalHorizon })
                }
              >
                {GOAL_HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {HORIZON_LABELS[h]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700">Theme</label>
              <select
                className="input mt-1"
                value={draft.theme}
                onChange={(e) =>
                  setDraft({ ...draft, theme: e.target.value as Theme })
                }
              >
                {THEMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-700">
              Macro themes{" "}
              <span className="text-slate-400">
                (which life-buckets this goal lives in — multi-select)
              </span>
            </label>
            <div className="mt-1 flex flex-wrap gap-1">
              {MACRO_THEMES.filter((m) => m !== "events").map((mt) => {
                const active = (draft.macroThemes ?? []).includes(mt);
                return (
                  <button
                    key={mt}
                    type="button"
                    onClick={() => {
                      const cur = draft.macroThemes ?? [];
                      const next = active
                        ? cur.filter((m) => m !== mt)
                        : [...cur, mt];
                      setDraft({ ...draft, macroThemes: next });
                    }}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      active
                        ? "border-slate-900 bg-gradient-to-b from-slate-800 to-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                    }`}
                    title={MACRO_THEME_LABELS[mt]}
                  >
                    {MACRO_THEME_LABELS[mt]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Leave empty and we'll auto-detect from the goal title — e.g.
              "Education" picks up Learning. Multi-select for goals that
              cross buckets (a debt-payoff goal is Money + Stress).
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-700">
              Notes <span className="text-slate-400">(why it matters / target)</span>
            </label>
            <textarea
              className="input mt-1"
              rows={2}
              value={draft.notes ?? ""}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn-primary">
              Save goal
            </button>
          </div>
        </form>
      )}

      {/* Macro filter pills — top-level filter chips by life bucket
          (Money / Learning / Stress / Health / Career / Family / Creative
          / Admin). Each goal can live in multiple buckets so the totals
          can exceed goals.length. Hidden when only 0-1 macros have any
          goals (single-bucket user doesn't need redundant chrome). */}
      {macroCounts.size >= 2 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setMacroFilter(null)}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              macroFilter === null
                ? "border-slate-900 bg-gradient-to-b from-slate-800 to-slate-900 text-white shadow-sm"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
            }`}
          >
            All · {goals.length}
          </button>
          {MACRO_THEMES.filter((m) => m !== "events").map((m) => {
            const count = macroCounts.get(m) ?? 0;
            if (count === 0) return null;
            const active = macroFilter === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMacroFilter(active ? null : m)}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  active
                    ? "border-slate-900 bg-gradient-to-b from-slate-800 to-slate-900 text-white shadow-sm"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                }`}
                title={`Filter to ${MACRO_THEME_LABELS[m]} goals`}
              >
                {MACRO_THEME_LABELS[m]} · {count}
              </button>
            );
          })}
        </div>
      )}

      {goals.length === 0 ? (
        <div className="card text-center text-sm text-slate-500">
          No goals yet. Add one to start laddering tasks toward something bigger.
        </div>
      ) : visibleGoals.length === 0 ? (
        <div className="card text-center text-sm text-slate-500">
          No goals in this theme yet. Click a different pill above, or
          <button
            type="button"
            onClick={() => setMacroFilter(null)}
            className="ml-1 text-slate-700 underline"
          >
            show all
          </button>
          .
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ horizon, items }) => (
            <div key={horizon}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {HORIZON_LABELS[horizon]}
              </h3>
              <ul className="space-y-2">
                {items.map((g) => {
                  const count = taskCountByGoal.get(g.id) ?? 0;
                  const linkedTasks = tasksByGoal.get(g.id) ?? [];
                  const prog = progressByGoal?.get(g.id);
                  const done30 = prog?.doneLast30 ?? 0;
                  const activityLabel = relativeDays(prog?.lastActivityIso);
                  const ms = prog?.lastActivityIso
                    ? Date.now() - new Date(prog.lastActivityIso).getTime()
                    : Infinity;
                  const stalePastWeek = ms > 7 * 24 * 60 * 60 * 1000;
                  const stalePastMonth = ms > 30 * 24 * 60 * 60 * 1000;
                  const isExpanded = expanded.has(g.id);
                  const hasDetails =
                    Boolean(g.notes) || linkedTasks.length > 0;
                  return (
                    <li
                      key={g.id}
                      className={`rounded-xl border border-slate-200/80 bg-white px-3 py-2 shadow-sm shadow-slate-200/50 ${
                        stalePastMonth
                          ? "border-l-4 border-l-red-400"
                          : stalePastWeek
                          ? "border-l-4 border-l-amber-400"
                          : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => hasDetails && toggleExpanded(g.id)}
                          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
                            hasDetails ? "cursor-pointer" : "cursor-default"
                          }`}
                          aria-expanded={isExpanded}
                          aria-label={
                            hasDetails
                              ? `${isExpanded ? "Collapse" : "Expand"} ${g.title}`
                              : g.title
                          }
                          disabled={!hasDetails}
                        >
                          {hasDetails && (
                            <span
                              className={`flex-none text-[10px] text-slate-400 transition-transform ${
                                isExpanded ? "rotate-90" : ""
                              }`}
                              aria-hidden
                            >
                              ▶
                            </span>
                          )}
                          <span className="truncate text-sm font-medium">
                            {g.title}
                          </span>
                          <ThemeBadge theme={g.theme} />
                          <span className="flex-none rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                            {count}
                          </span>
                          {done30 > 0 && (
                            <span
                              className="flex-none rounded-full bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800"
                              title="Tasks linked to this goal completed in the last 30 days"
                            >
                              {done30}/30d
                            </span>
                          )}
                          <span
                            className={`flex-none text-[11px] ${
                              stalePastMonth
                                ? "font-semibold text-red-700"
                                : stalePastWeek
                                ? "font-semibold text-amber-700"
                                : "text-slate-500"
                            }`}
                            title={
                              prog?.lastActivityIso
                                ? new Date(prog.lastActivityIso).toLocaleString()
                                : "no linked-task activity yet"
                            }
                          >
                            {stalePastWeek ? "⚠ " : ""}
                            {activityLabel}
                          </span>
                        </button>
                        <div className="flex flex-none items-center gap-2 text-[11px]">
                          {onAddTaskForGoal && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onAddTaskForGoal(g.id);
                              }}
                              className="text-emerald-700 hover:text-emerald-900"
                              title="Add a new task linked to this goal"
                            >
                              + Task
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const next = window.prompt(
                                "Edit goal title",
                                g.title,
                              );
                              if (next && next.trim())
                                onUpdate(g.id, { title: next.trim() });
                            }}
                            className="text-slate-500 hover:text-slate-900"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`Delete goal "${g.title}"?`))
                                onRemove(g.id);
                            }}
                            className="text-slate-400 hover:text-red-600"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      {isExpanded && hasDetails && (
                        <div className="mt-2 border-t border-slate-100 pt-2">
                          {g.notes && (
                            <p className="text-sm text-slate-600">{g.notes}</p>
                          )}
                          {linkedTasks.length > 0 && (
                            <ul className="mt-2 flex flex-wrap gap-1.5">
                              {linkedTasks.map((t) => (
                                <li key={t.id}>
                                  <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700">
                                    <span className="max-w-[16rem] truncate">
                                      {t.title}
                                    </span>
                                    {onUnlinkTaskFromGoal && (
                                      <button
                                        type="button"
                                        className="text-slate-400 hover:text-red-600"
                                        onClick={() =>
                                          onUnlinkTaskFromGoal(t.id, g.id)
                                        }
                                        title="Unlink from this goal"
                                        aria-label={`Unlink ${t.title}`}
                                      >
                                        ✕
                                      </button>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
