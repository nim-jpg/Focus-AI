import { useEffect } from "react";
import { TaskForm } from "./TaskForm";
import type { Goal, Task } from "@/types/task";
import type { NewTaskInput } from "@/lib/useTasks";

interface Props {
  /** Pass an existing task to render in Edit mode; omit for a new task. */
  initialTask?: Task;
  goals: Goal[];
  /** Pre-link these goals on a brand-new task (ignored when editing). */
  presetGoalIds?: string[];
  onSubmit: (input: NewTaskInput) => void;
  onClose: () => void;
}

export function TaskFormModal({
  initialTask,
  goals,
  presetGoalIds,
  onSubmit,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 px-4 py-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">
            {initialTask ? `Edit "${initialTask.title}"` : "Add task"}
          </h3>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-900"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <TaskForm
          key={initialTask?.id ?? `new-${(presetGoalIds ?? []).join(",")}`}
          initialTask={initialTask}
          goals={goals}
          presetGoalIds={presetGoalIds}
          onSubmit={(input) => {
            onSubmit(input);
            onClose();
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
