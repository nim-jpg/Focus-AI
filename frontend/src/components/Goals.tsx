import { useState } from "react";
import {
  GOAL_HORIZONS,
  THEMES,
  type Goal,
  type GoalHorizon,
  type Task,
  type Theme,
} from "@/types/task";
import type { NewGoalInput } from "@/lib/useGoals";
import { ThemeBadge } from "./ThemeBadge";
import { suggestGoalTasks, type GoalTaskMatch } from "@/lib/suggestGoalTasks";

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
  onLinkTaskToGoal,
}: Props) {
  const [draft, setDraft] = useState<NewGoalInput>(blank);
  const [open, setOpen] = useState(false);
  // Per-goal AI-suggestion state.
  const [suggestState, setSuggestState] = useState<
    Record<string, {
      loading: boolean;
      matches?: GoalTaskMatch[];
      error?: string;
    }>
  >({});

  const runSuggest = async (goal: Goal) => {
    setSuggestState((s) => ({ ...s, [goal.id]: { loading: true } }));
    const candidates = tasks.filter(
      (t) => t.status !== "completed" && !(t.goalIds ?? []).includes(goal.id),
    );
    try {
      const matches = await suggestGoalTasks(goal, candidates);
      setSuggestState((s) => ({
        ...s,
        [goal.id]: { loading: false, matches },
      }));
    } catch (err) {
      setSuggestState((s) => ({
        ...s,
        [goal.id]: {
          loading: false,
          error: err instanceof Error ? err.message : "AI unavailable",
        },
      }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) return;
    onAdd({ ...draft, title: draft.title.trim() });
    setDraft(blank);
    setOpen(false);
  };

  const grouped = HORIZON_ORDER.map((horizon) => ({
    horizon,
    items: goals.filter((g) => g.horizon === horizon),
  })).filter((g) => g.items.length > 0);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Goals</h2>
          <p className="text-xs text-slate-500">
            What you're working toward. Tasks can ladder up to these.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Cancel" : "Add goal"}
        </button>
      </div>

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

      {goals.length === 0 ? (
        <div className="card text-center text-sm text-slate-500">
          No goals yet. Add one to start laddering tasks toward something bigger.
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
                  const prog = progressByGoal?.get(g.id);
                  const done30 = prog?.doneLast30 ?? 0;
                  const activityLabel = relativeDays(prog?.lastActivityIso);
                  const ms = prog?.lastActivityIso
                    ? Date.now() - new Date(prog.lastActivityIso).getTime()
                    : Infinity;
                  const stalePastWeek = ms > 7 * 24 * 60 * 60 * 1000;
                  const stalePastMonth = ms > 30 * 24 * 60 * 60 * 1000;
                  return (
                    <li
                      key={g.id}
                      className={`card flex items-start justify-between gap-3 ${
                        stalePastMonth
                          ? "border-l-4 border-l-red-400"
                          : stalePastWeek
                          ? "border-l-4 border-l-amber-400"
                          : ""
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{g.title}</span>
                          <ThemeBadge theme={g.theme} />
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                            {count} open {count === 1 ? "task" : "tasks"}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              done30 > 0
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-slate-100 text-slate-500"
                            }`}
                            title="Tasks linked to this goal completed in the last 30 days"
                          >
                            {done30} done in 30d
                          </span>
                          <span
                            className={`text-xs ${
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
                        </div>
                        {g.notes && (
                          <p className="mt-1 text-sm text-slate-600">{g.notes}</p>
                        )}
                        {/* AI-suggested task allocation. Surfaces when no
                            tasks are linked yet — one click asks Claude to
                            pick existing tasks that ladder to this goal. */}
                        {onLinkTaskToGoal && count === 0 && (() => {
                          const ss = suggestState[g.id];
                          const matches = ss?.matches ?? [];
                          const hasResult = !!ss && !ss.loading;
                          return (
                            <div className="mt-2 rounded-md border border-dashed border-slate-200 bg-slate-50 p-2">
                              {!ss && (
                                <button
                                  type="button"
                                  className="text-xs font-medium text-indigo-700 hover:text-indigo-900"
                                  onClick={() => void runSuggest(g)}
                                >
                                  ✨ Find matching tasks with AI
                                </button>
                              )}
                              {ss?.loading && (
                                <p className="text-xs italic text-slate-500">
                                  asking Claude…
                                </p>
                              )}
                              {ss?.error && (
                                <p className="text-xs text-amber-700">
                                  {ss.error}
                                </p>
                              )}
                              {hasResult && matches.length === 0 && !ss?.error && (
                                <p className="text-xs text-slate-500">
                                  No matches in your current tasks. Add a new
                                  one with the + Task button.
                                </p>
                              )}
                              {hasResult && matches.length > 0 && (
                                <ul className="space-y-1.5">
                                  {matches.map((m) => {
                                    const t = tasks.find(
                                      (x) => x.id === m.taskId,
                                    );
                                    if (!t) return null;
                                    const linked = (t.goalIds ?? []).includes(
                                      g.id,
                                    );
                                    return (
                                      <li
                                        key={m.taskId}
                                        className="flex items-start gap-2 text-xs"
                                      >
                                        <span className="mt-0.5 inline-block w-12 flex-none rounded-full bg-white px-1.5 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                          {m.confidence}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                          <p className="font-medium text-slate-700">
                                            {t.title}
                                          </p>
                                          <p className="text-[11px] text-slate-500">
                                            {m.reason}
                                          </p>
                                        </div>
                                        <button
                                          type="button"
                                          className="flex-none rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800 hover:border-emerald-500 disabled:opacity-50"
                                          disabled={linked}
                                          onClick={() =>
                                            onLinkTaskToGoal(t.id, g.id)
                                          }
                                        >
                                          {linked ? "Linked" : "Link"}
                                        </button>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                      <div className="flex flex-col gap-1 text-xs">
                        {onAddTaskForGoal && (
                          <button
                            type="button"
                            onClick={() => onAddTaskForGoal(g.id)}
                            className="text-emerald-700 hover:text-emerald-900"
                            title="Add a new task linked to this goal"
                          >
                            + Task
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            const next = window.prompt("Edit goal title", g.title);
                            if (next && next.trim()) onUpdate(g.id, { title: next.trim() });
                          }}
                          className="text-slate-500 hover:text-slate-900"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Delete goal "${g.title}"?`)) onRemove(g.id);
                          }}
                          className="text-slate-400 hover:text-red-600"
                        >
                          Delete
                        </button>
                      </div>
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
