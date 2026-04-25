import { useMemo } from "react";
import { TaskForm } from "@/components/TaskForm";
import { TaskList } from "@/components/TaskList";
import { TopThree } from "@/components/TopThree";
import { ModeSwitch } from "@/components/ModeSwitch";
import { useTasks } from "@/lib/useTasks";
import { prioritize } from "@/lib/prioritize";

export default function App() {
  const { tasks, prefs, addTask, removeTask, toggleComplete, setPrefs } =
    useTasks();

  const prioritized = useMemo(
    () => prioritize(tasks, { prefs, limit: 3 }),
    [tasks, prefs],
  );

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const completionRate =
    tasks.length === 0 ? 0 : Math.round((completedCount / tasks.length) * 100);

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Focus3</h1>
          <p className="text-sm text-slate-600">
            Three things, every day. Your non-negotiables, surfaced.
          </p>
        </div>
        <ModeSwitch mode={prefs.mode} onChange={(mode) => setPrefs({ mode })} />
      </header>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Today&apos;s Top Three</h2>
          <span className="text-xs text-slate-500">
            {completedCount}/{tasks.length} completed · {completionRate}%
          </span>
        </div>
        <TopThree
          prioritized={prioritized}
          onComplete={toggleComplete}
          onSchedule={() => {}}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Add a task</h2>
        <TaskForm onSubmit={addTask} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">All tasks</h2>
        <TaskList
          tasks={tasks}
          onToggle={toggleComplete}
          onRemove={removeTask}
        />
      </section>

      <footer className="pt-4 text-center text-xs text-slate-400">
        Local-only MVP · Calendar, OCR &amp; PDF coming soon
      </footer>
    </div>
  );
}
