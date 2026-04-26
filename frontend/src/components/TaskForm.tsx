import { useEffect, useState } from "react";
import {
  PRIVACY_LEVELS,
  RECURRENCE_PATTERNS,
  THEMES,
  TIME_OF_DAY,
  URGENCY_LEVELS,
  type Privacy,
  type Recurrence,
  type Task,
  type Theme,
  type TimeOfDay,
  type Urgency,
} from "@/types/task";
import type { NewTaskInput } from "@/lib/useTasks";

interface Props {
  onSubmit: (input: NewTaskInput) => void;
  /** When set, form runs in edit mode: pre-fills, swaps button label, calls onSubmit with patch values. */
  initialTask?: Task;
  onCancel?: () => void;
}

const blank: NewTaskInput = {
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
  timeOfDay: "anytime",
};

function fromTask(task: Task): NewTaskInput {
  return {
    title: task.title,
    description: task.description ?? "",
    theme: task.theme,
    estimatedMinutes: task.estimatedMinutes,
    dueDate: task.dueDate,
    urgency: task.urgency,
    privacy: task.privacy,
    isWork: task.isWork,
    isBlocker: task.isBlocker,
    blockedBy: task.blockedBy ?? [],
    recurrence: task.recurrence,
    timeOfDay: task.timeOfDay ?? "anytime",
    counter: task.counter,
  };
}

export function TaskForm({ onSubmit, initialTask, onCancel }: Props) {
  const [form, setForm] = useState<NewTaskInput>(
    initialTask ? fromTask(initialTask) : blank,
  );
  const [counterTarget, setCounterTarget] = useState<number | "">(
    initialTask?.counter?.target ?? "",
  );

  // When editing a different task, repopulate.
  useEffect(() => {
    if (initialTask) {
      setForm(fromTask(initialTask));
      setCounterTarget(initialTask.counter?.target ?? "");
    }
  }, [initialTask]);

  const update = <K extends keyof NewTaskInput>(key: K, value: NewTaskInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;

    const payload: NewTaskInput = {
      ...form,
      title: form.title.trim(),
      counter:
        typeof counterTarget === "number" && counterTarget > 0
          ? {
              target: counterTarget,
              date: new Date().toISOString().slice(0, 10),
              count: initialTask?.counter?.count ?? 0,
            }
          : undefined,
    };

    onSubmit(payload);
    if (!initialTask) {
      setForm(blank);
      setCounterTarget("");
    }
  };

  const isEdit = Boolean(initialTask);

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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="text-xs font-medium text-slate-700">Time of day</label>
          <select
            className="input mt-1"
            value={form.timeOfDay ?? "anytime"}
            onChange={(e) => update("timeOfDay", e.target.value as TimeOfDay)}
          >
            {TIME_OF_DAY.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700">Due date</label>
          <input
            type="date"
            className="input mt-1"
            value={form.dueDate?.slice(0, 10) ?? ""}
            onChange={(e) =>
              update(
                "dueDate",
                e.target.value ? new Date(e.target.value).toISOString() : undefined,
              )
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
        <div>
          <label className="text-xs font-medium text-slate-700">
            Counter target
            <span className="ml-1 text-slate-400">(e.g. 8 glasses)</span>
          </label>
          <input
            type="number"
            min={0}
            step={1}
            className="input mt-1"
            placeholder="optional"
            value={counterTarget}
            onChange={(e) =>
              setCounterTarget(e.target.value === "" ? "" : Number(e.target.value))
            }
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
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
        <div className="flex gap-2">
          {isEdit && onCancel && (
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn-primary">
            {isEdit ? "Save changes" : "Add task"}
          </button>
        </div>
      </div>
    </form>
  );
}
