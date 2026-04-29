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
  /** Optional: switch to brain dump (paste a list, no per-task form). The
   *  link only appears for new-task mode — editing an existing task is
   *  not the right context for "discard this and dump a list" UX. */
  onSwitchToBrainDump?: () => void;
}

export function TaskFormModal({
  initialTask,
  goals,
  presetGoalIds,
  onSubmit,
  onClose,
  onSwitchToBrainDump,
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
      className="fixed inset-0 z-40 flex items-stretch justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm sm:items-start sm:px-4 sm:py-8"
      onClick={onClose}
    >
      <div
        className="flex min-h-screen w-full max-w-3xl flex-col bg-white shadow-xl sm:min-h-0 sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:border-0 sm:px-5 sm:pt-5 sm:pb-3">
          <div>
            <h3 className="text-base font-semibold">
              {initialTask ? `Edit "${initialTask.title}"` : "Add task"}
            </h3>
            {!initialTask && onSwitchToBrainDump && (
              <p className="mt-0.5 text-xs text-slate-500">
                Got a whole list?{" "}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onSwitchToBrainDump();
                  }}
                  className="font-medium text-slate-700 underline-offset-2 hover:text-slate-900 hover:underline"
                >
                  Use brain dump
                </button>{" "}
                — paste everything at once, Claude infers the rest.
              </p>
            )}
          </div>
          <button
            type="button"
            className="-mr-1 inline-flex h-10 w-10 flex-none items-center justify-center rounded text-2xl text-slate-500 hover:bg-slate-100 hover:text-slate-900"
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
