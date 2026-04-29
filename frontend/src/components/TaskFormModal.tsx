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
      className="fixed inset-0 z-40 flex items-stretch justify-center overflow-y-auto bg-slate-900/40 sm:items-start sm:px-4 sm:py-8"
      onClick={onClose}
    >
      <div
        className="flex min-h-screen w-full max-w-3xl flex-col bg-white shadow-xl sm:min-h-0 sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:border-0 sm:px-5 sm:pt-5 sm:pb-3">
          <h3 className="text-base font-semibold">
            {initialTask ? `Edit "${initialTask.title}"` : "Add task"}
          </h3>
          <button
            type="button"
            className="-mr-1 inline-flex h-10 w-10 items-center justify-center rounded text-2xl text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
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
    </div>
  );
}
