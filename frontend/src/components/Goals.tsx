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

interface AppliedMatch extends GoalTaskMatch {
  goalId: string;
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
  onUnlinkTaskFromGoal,
  compact = false,
}: Props) {
  const [draft, setDraft] = useState<NewGoalInput>(blank);
  const [open, setOpen] = useState(false);
  // Global match-to-goals AI run state.
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [appliedMatches, setAppliedMatches] = useState<AppliedMatch[] | null>(
    null,
  );

  const runMatchAll = async () => {
    if (!onLinkTaskToGoal) return;
    setMatchBusy(true);
    setMatchError(null);
    setAppliedMatches(null);
    const applied: AppliedMatch[] = [];
    let goalsConsidered = 0;
    try {
      // Process goals sequentially to keep request volume modest and to
      // share the same `tasks` snapshot across calls.
      for (const g of goals) {
        const candidates = tasks.filter(
          (t) =>
            t.status !== "completed" && !(t.goalIds ?? []).includes(g.id),
        );
        if (candidates.length === 0) continue;
        goalsConsidered += 1;
        const matches = await suggestGoalTasks(g, candidates);
        for (const m of matches) {
          // Auto-link every match the model returns (any confidence). The
          // user can unlink anything they don't want from the result banner
          // or the per-goal chips below.
          onLinkTaskToGoal(m.taskId, g.id);
          applied.push({ ...m, goalId: g.id });
        }
      }
      setAppliedMatches(applied);
      if (applied.length === 0 && goalsConsidered === 0) {
        setMatchError(
          "Every open task is already linked to every goal — nothing to match.",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI unavailable";
      console.error("[Goals] match failed:", err);
      setMatchError(msg);
    } finally {
      setMatchBusy(false);
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
          {onLinkTaskToGoal && goals.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void runMatchAll()}
              disabled={matchBusy}
              title="Ask Claude to scan all open tasks and link the ones that ladder to your goals"
            >
              {matchBusy ? "Matching…" : "✨ Match tasks to goals"}
            </button>
          )}
        </div>
      </div>

      {/* Result banner from the global AI match action. Shows what was
          auto-linked so the user can scan and selectively unlink anything
          that doesn't fit. */}
      {(appliedMatches !== null || matchError) && (
        <div className="card mb-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-slate-700">
              {matchError
                ? "Match failed"
                : appliedMatches && appliedMatches.length > 0
                ? `Auto-linked ${appliedMatches.length} task${
                    appliedMatches.length === 1 ? "" : "s"
                  }`
                : "No new matches found"}
            </p>
            <button
              type="button"
              className="text-xs text-slate-400 hover:text-slate-700"
              onClick={() => {
                setAppliedMatches(null);
                setMatchError(null);
              }}
            >
              dismiss
            </button>
          </div>
          {matchError && (
            <p className="text-xs text-amber-700">{matchError}</p>
          )}
          {appliedMatches && appliedMatches.length > 0 && (
            <ul className="space-y-1.5">
              {appliedMatches.map((m, idx) => {
                const t = tasks.find((x) => x.id === m.taskId);
                const g = goals.find((x) => x.id === m.goalId);
                if (!t || !g) return null;
                const stillLinked = (t.goalIds ?? []).includes(m.goalId);
                return (
                  <li
                    key={`${m.goalId}:${m.taskId}:${idx}`}
                    className="flex items-start gap-2 text-xs"
                  >
                    <span className="mt-0.5 inline-block w-12 flex-none rounded-full bg-slate-100 px-1.5 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide text-slate-500">
                      {m.confidence}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-slate-700">
                        <span className="font-medium">{t.title}</span>
                        <span className="mx-1 text-slate-400">→</span>
                        <span className="text-slate-600">{g.title}</span>
                      </p>
                      <p className="text-[11px] text-slate-500">{m.reason}</p>
                    </div>
                    {onUnlinkTaskFromGoal && stillLinked && (
                      <button
                        type="button"
                        className="flex-none rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-red-400 hover:text-red-700"
                        onClick={() =>
                          onUnlinkTaskFromGoal(m.taskId, m.goalId)
                        }
                        title="Remove this auto-link"
                      >
                        ✕ unlink
                      </button>
                    )}
                    {onUnlinkTaskFromGoal && !stillLinked && (
                      <span className="flex-none text-[11px] italic text-slate-400">
                        unlinked
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

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
                  const linkedTasks = tasksByGoal.get(g.id) ?? [];
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
                        {/* Linked tasks with one-click unlink — lets the
                            user prune anything the AI mis-matched. */}
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
