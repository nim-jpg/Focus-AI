import { useState } from "react";
import {
  PRIVACY_LEVELS,
  RECURRENCE_PATTERNS,
  THEMES,
  URGENCY_LEVELS,
  type Privacy,
  type Recurrence,
  type Theme,
  type Urgency,
} from "@/types/task";
import type { NewTaskInput } from "@/lib/useTasks";

interface Props {
  onSubmit: (input: NewTaskInput) => void;
}

const initial: NewTaskInput = {
  title: "",
  description: "",
  theme: "work",
  estimatedMinutes: 30,
  dueDate: undefined,
  urgency: "normal",
  privacy: "private",
  isWork: true,
  isBlocker: false,
  blockedBy: [],
  recurrence: "none",
};

export function TaskForm({ onSubmit }: Props) {
  const [form, setForm] = useState<NewTaskInput>(initial);

  const update = <K extends keyof NewTaskInput>(key: K, value: NewTaskInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSubmit({ ...form, title: form.title.trim() });
    setForm(initial);
  };

  return (
    <form onSubmit={handleSubmit} className="card space-y-3">
      <div>
        <label className="text-xs font-medium text-slate-700">Title</label>
        <input
          className="input mt-1"
          placeholder="e.g. Submit quarterly tax return"
          value={form.title}
          onChange={(e) => update("title", e.target.value)}
          required
        />
      </div>

      <div>
        <label className="text-xs font-medium text-slate-700">Description</label>
        <textarea
          className="input mt-1"
          rows={2}
          value={form.description ?? ""}
          onChange={(e) => update("description", e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="text-xs font-medium text-slate-700">Theme</label>
          <select
            className="input mt-1"
            value={form.theme}
            onChange={(e) => {
              const theme = e.target.value as Theme;
              update("theme", theme);
              update("isWork", theme === "work");
            }}
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-700">Urgency</label>
          <select
            className="input mt-1"
            value={form.urgency}
            onChange={(e) => update("urgency", e.target.value as Urgency)}
          >
            {URGENCY_LEVELS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-700">Privacy</label>
          <select
            className="input mt-1"
            value={form.privacy}
            onChange={(e) => update("privacy", e.target.value as Privacy)}
          >
            {PRIVACY_LEVELS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-700">Recurrence</label>
          <select
            className="input mt-1"
            value={form.recurrence}
            onChange={(e) => update("recurrence", e.target.value as Recurrence)}
          >
            {RECURRENCE_PATTERNS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <label className="text-xs font-medium text-slate-700">Due date</label>
          <input
            type="date"
            className="input mt-1"
            value={form.dueDate?.slice(0, 10) ?? ""}
            onChange={(e) =>
              update("dueDate", e.target.value ? new Date(e.target.value).toISOString() : undefined)
            }
          />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700">Est. minutes</label>
          <input
            type="number"
            min={5}
            step={5}
            className="input mt-1"
            value={form.estimatedMinutes ?? 30}
            onChange={(e) => update("estimatedMinutes", Number(e.target.value))}
          />
        </div>
        <div className="flex items-end gap-3 pb-1.5 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isWork}
              onChange={(e) => update("isWork", e.target.checked)}
            />
            Work context
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isBlocker}
              onChange={(e) => update("isBlocker", e.target.checked)}
            />
            Blocker
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <button type="submit" className="btn-primary">
          Add task
        </button>
      </div>
    </form>
  );
}
