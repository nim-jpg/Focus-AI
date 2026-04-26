import { useState } from "react";
import {
  GOAL_HORIZONS,
  THEMES,
  type Goal,
  type GoalHorizon,
  type Theme,
} from "@/types/task";
import type { NewGoalInput } from "@/lib/useGoals";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  goals: Goal[];
  taskCountByGoal: Map<string, number>;
  onAdd: (input: NewGoalInput) => void;
  onUpdate: (id: string, patch: Partial<Goal>) => void;
  onRemove: (id: string) => void;
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

export function Goals({ goals, taskCountByGoal, onAdd, onUpdate, onRemove }: Props) {
  const [draft, setDraft] = useState<NewGoalInput>(blank);
  const [open, setOpen] = useState(false);

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
                  return (
                    <li
                      key={g.id}
                      className="card flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{g.title}</span>
                          <ThemeBadge theme={g.theme} />
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                            {count} {count === 1 ? "task" : "tasks"}
                          </span>
                        </div>
                        {g.notes && (
                          <p className="mt-1 text-sm text-slate-600">{g.notes}</p>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 text-xs">
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
