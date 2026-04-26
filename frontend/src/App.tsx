import { useEffect, useMemo, useState } from "react";
import { TaskForm } from "@/components/TaskForm";
import { TaskList } from "@/components/TaskList";
import { TopThree } from "@/components/TopThree";
import { ModeSwitch } from "@/components/ModeSwitch";
import { BrainDump } from "@/components/BrainDump";
import { Basics } from "@/components/Basics";
import { useTasks } from "@/lib/useTasks";
import { prioritize } from "@/lib/prioritize";
import { aiPrioritize, AiUnavailableError } from "@/lib/aiPrioritize";
import { isBasic, wasCompletedToday } from "@/lib/recurrence";
import type { PrioritizedTask } from "@/types/task";

type Source = "local" | "claude";

export default function App() {
  const { tasks, prefs, addTask, removeTask, toggleComplete, setPrefs } =
    useTasks();

  const local = useMemo(
    () => prioritize(tasks, { prefs, limit: 3 }),
    [tasks, prefs],
  );

  const basics = useMemo(
    () => tasks.filter((t) => isBasic(t) && t.status !== "completed"),
    [tasks],
  );

  const [aiResult, setAiResult] = useState<PrioritizedTask[] | null>(null);
  const [source, setSource] = useState<Source>("local");
  const [loading, setLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // If task ids change (added/removed/completed), the cached AI result becomes
  // stale — drop it so we show the fresh local heuristic.
  const taskFingerprint = useMemo(
    () =>
      tasks
        .filter((t) => t.status !== "completed")
        .map((t) => t.id)
        .sort()
        .join(","),
    [tasks],
  );
  useEffect(() => {
    setAiResult(null);
    setSource("local");
  }, [taskFingerprint, prefs.mode]);

  const prioritized = source === "claude" && aiResult ? aiResult : local;

  const handleAiRefresh = async () => {
    setLoading(true);
    setAiError(null);
    try {
      const result = await aiPrioritize(tasks, prefs);
      setAiResult(result);
      setSource("claude");
    } catch (err) {
      const reason =
        err instanceof AiUnavailableError ? err.message : "unexpected error";
      setAiError(`AI unavailable — using local heuristic (${reason})`);
      setSource("local");
    } finally {
      setLoading(false);
    }
  };

  // "Today's actions": one-shot tasks completed today + recurring tasks ticked today.
  const today = new Date();
  const isToday = (iso?: string) => {
    if (!iso) return false;
    const d = new Date(iso);
    return d.toDateString() === today.toDateString();
  };
  const todayDoneCount = tasks.filter((t) =>
    t.recurrence === "none"
      ? t.status === "completed" && isToday(t.updatedAt)
      : wasCompletedToday(t, today),
  ).length;
  const todayActionable = tasks.filter(
    (t) => t.recurrence !== "none" || t.status !== "completed",
  ).length;

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

      <Basics tasks={basics} onComplete={toggleComplete} />

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Today&apos;s Top Three</h2>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                source === "claude"
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-slate-100 text-slate-600"
              }`}
              title={
                source === "claude"
                  ? "Prioritized by Claude"
                  : "Local heuristic — click Refresh with AI for Claude reasoning"
              }
            >
              {source === "claude" ? "AI" : "Local"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {todayDoneCount}/{todayActionable} done today
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleAiRefresh}
              disabled={loading || tasks.length === 0}
            >
              {loading ? "Asking Claude…" : "Refresh with AI"}
            </button>
          </div>
        </div>
        {aiError && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {aiError}
          </div>
        )}
        <TopThree
          prioritized={prioritized}
          onComplete={toggleComplete}
          onSchedule={() => {}}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Add tasks</h2>
        <BrainDump onAdd={addTask} />
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
