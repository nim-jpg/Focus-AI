import { useEffect, useMemo, useState } from "react";
import { TaskForm } from "@/components/TaskForm";
import { TaskList } from "@/components/TaskList";
import { TopThree } from "@/components/TopThree";
import { ModeSwitch } from "@/components/ModeSwitch";
import { BrainDump } from "@/components/BrainDump";
import { Foundations } from "@/components/Foundations";
import { TomorrowPreview } from "@/components/TomorrowPreview";
import { Goals } from "@/components/Goals";
import { PriorityMatrix } from "@/components/PriorityMatrix";
import { useGoals } from "@/lib/useGoals";
import { useTasks } from "@/lib/useTasks";
import { prioritize } from "@/lib/prioritize";
import { aiPrioritize, AiUnavailableError } from "@/lib/aiPrioritize";
import { isFoundation, wasCompletedToday } from "@/lib/recurrence";
import type { PrioritizedTask } from "@/types/task";

type Source = "local" | "claude";

export default function App() {
  const {
    tasks,
    prefs,
    addTask,
    updateTask,
    removeTask,
    toggleComplete,
    incrementCounter,
    markSurfaced,
    setPrefs,
  } = useTasks();
  const { goals, addGoal, updateGoal, removeGoal } = useGoals();

  const taskCountByGoal = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === "completed") continue;
      for (const id of t.goalIds ?? []) {
        map.set(id, (map.get(id) ?? 0) + 1);
      }
    }
    return map;
  }, [tasks]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editingTask = editingId ? tasks.find((t) => t.id === editingId) : undefined;
  const startEdit = (id: string) => {
    setEditingId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const local = useMemo(
    () => prioritize(tasks, { prefs, limit: 3 }),
    [tasks, prefs],
  );

  const foundations = useMemo(
    () => tasks.filter((t) => isFoundation(t) && t.status !== "completed"),
    [tasks],
  );

  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }, [tasks]);

  const tomorrowPreview = useMemo(() => {
    const todaysIds = new Set(local.map((p) => p.task.id));
    return prioritize(tasks, { prefs, limit: 3, now: tomorrow }).filter(
      (p) => !todaysIds.has(p.task.id),
    );
  }, [tasks, prefs, tomorrow, local]);

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

  // When the visible Top Three changes, stamp those tasks as surfaced. The hook
  // also auto-bumps avoidanceWeeks when 7+ days have passed without action.
  const surfacedFingerprint = prioritized.map((p) => p.task.id).join(",");
  useEffect(() => {
    if (prioritized.length === 0) return;
    markSurfaced(prioritized.map((p) => p.task.id));
    // intentionally only depend on the fingerprint string, not the array identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfacedFingerprint]);

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

      <Foundations
        tasks={foundations}
        onComplete={toggleComplete}
        onIncrement={incrementCounter}
        onEdit={startEdit}
      />

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
          goals={goals}
        />
      </section>

      <TomorrowPreview prioritized={tomorrowPreview} onDoEarly={toggleComplete} />

      <PriorityMatrix tasks={tasks} onEdit={startEdit} />

      <Goals
        goals={goals}
        taskCountByGoal={taskCountByGoal}
        onAdd={addGoal}
        onUpdate={updateGoal}
        onRemove={removeGoal}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          {editingTask ? `Edit "${editingTask.title}"` : "Add tasks"}
        </h2>
        {!editingTask && <BrainDump onAdd={addTask} />}
        <TaskForm
          key={editingId ?? "new"}
          initialTask={editingTask}
          goals={goals}
          onSubmit={(input) => {
            if (editingTask) {
              updateTask(editingTask.id, input);
              setEditingId(null);
            } else {
              addTask(input);
            }
          }}
          onCancel={editingTask ? () => setEditingId(null) : undefined}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">All tasks</h2>
        <TaskList
          tasks={tasks}
          onToggle={toggleComplete}
          onRemove={removeTask}
          onEdit={startEdit}
        />
      </section>

      <footer className="pt-4 text-center text-xs text-slate-400">
        Local-only MVP · Calendar, OCR &amp; PDF coming soon
      </footer>
    </div>
  );
}
