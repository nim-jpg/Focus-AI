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
import { SuggestDates } from "@/components/SuggestDates";
import { CompanyAssist } from "@/components/CompanyAssist";
import { DaySchedule } from "@/components/DaySchedule";
import { PlannerScan, type ResolvedUpdate } from "@/components/PlannerScan";
import { useGoals } from "@/lib/useGoals";
import { useTasks } from "@/lib/useTasks";
import { prioritize } from "@/lib/prioritize";
import { aiPrioritize, AiUnavailableError } from "@/lib/aiPrioritize";
import {
  intendedScheduleDate,
  isFoundation,
  wasCompletedLate,
  wasCompletedToday,
} from "@/lib/recurrence";
import { exportWeeklyPlanner } from "@/lib/pdfPlanner";
import {
  CalendarError,
  disconnectGoogle,
  fetchGoogleStatus,
  scheduleTask,
  startGoogleConnect,
  type GoogleStatus,
} from "@/lib/googleCalendar";
import type { PrioritizedTask } from "@/types/task";

type Source = "local" | "claude";
type View = "today" | "tasks" | "insights" | "goals";

const TAB_DEFS: Array<{ key: View; label: string }> = [
  { key: "today", label: "Today" },
  { key: "tasks", label: "Tasks" },
  { key: "insights", label: "Insights" },
  { key: "goals", label: "Goals" },
];

function loadInitialView(): View {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "tasks" || hash === "insights" || hash === "goals" || hash === "today") {
    return hash;
  }
  return "today";
}

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
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
  const [calendarMsg, setCalendarMsg] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => loadInitialView());

  // Reflect tab in URL hash so reload keeps the view.
  useEffect(() => {
    if (window.location.hash.replace(/^#/, "") !== view) {
      window.history.replaceState(null, "", `#${view}`);
    }
  }, [view]);
  const [scheduleConfirm, setScheduleConfirm] = useState<{
    taskId: string;
    title: string;
    intendedIso: string;
  } | null>(null);

  const handleTopThreeComplete = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      toggleComplete(id);
      return;
    }
    const isWeeklyPlus =
      task.recurrence !== "none" && task.recurrence !== "daily";
    const completingNow = task.status !== "completed";
    const late = isWeeklyPlus && completingNow && wasCompletedLate(task);
    toggleComplete(id);
    if (late) {
      const intended = intendedScheduleDate(task);
      if (intended) {
        setScheduleConfirm({
          taskId: id,
          title: task.title,
          intendedIso: intended.toISOString(),
        });
      }
    }
  };

  useEffect(() => {
    fetchGoogleStatus().then(setGoogleStatus).catch(() => setGoogleStatus(null));
    // If we just returned from the OAuth round-trip, surface a confirmation.
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      setCalendarMsg("Google Calendar connected.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleScheduleTask = async (taskId: string) => {
    if (!googleStatus?.connected) {
      if (!googleStatus?.configured) {
        setCalendarMsg(
          "Calendar isn't set up yet — see the README for the Google Cloud OAuth steps.",
        );
      } else {
        setCalendarMsg("Connect Google Calendar first (header → Connect Calendar).");
      }
      return;
    }
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    setCalendarMsg(null);
    try {
      const { htmlLink } = await scheduleTask(task);
      updateTask(taskId, { calendarEventId: "set" });
      setCalendarMsg(
        htmlLink
          ? `Scheduled "${task.title}" — opening Calendar`
          : `Scheduled "${task.title}".`,
      );
      if (htmlLink) window.open(htmlLink, "_blank", "noopener,noreferrer");
    } catch (err) {
      const reason =
        err instanceof CalendarError ? err.message : "unexpected error";
      setCalendarMsg(`Couldn't schedule — ${reason}`);
    }
  };
  const applyScanUpdate = (u: ResolvedUpdate) => {
    switch (u.action) {
      case "complete":
        toggleComplete(u.taskId);
        break;
      case "defer": {
        const days =
          typeof u.value === "number" ? u.value : Number(u.value) || 7;
        const until = new Date();
        until.setDate(until.getDate() + days);
        updateTask(u.taskId, { snoozedUntil: until.toISOString() });
        break;
      }
      case "block": {
        const until = new Date();
        until.setDate(until.getDate() + 14);
        updateTask(u.taskId, { snoozedUntil: until.toISOString() });
        break;
      }
      case "timeSpent": {
        const minutes =
          typeof u.value === "number" ? u.value : Number(u.value) || undefined;
        if (minutes) updateTask(u.taskId, { estimatedMinutes: minutes });
        break;
      }
      case "rename": {
        if (typeof u.value === "string" && u.value.trim()) {
          updateTask(u.taskId, { title: u.value.trim() });
        }
        break;
      }
    }
  };

  const startEdit = (id: string) => {
    setEditingId(id);
    setView("tasks");
    // Scroll to the form after the Tasks view renders.
    setTimeout(() => {
      document
        .getElementById("task-form-section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
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
        <div className="flex items-center gap-2">
          {googleStatus && !googleStatus.configured && (
            <span
              className="text-xs text-slate-500"
              title="Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env. See README."
            >
              Calendar: setup needed
            </span>
          )}
          {googleStatus?.configured && !googleStatus.connected && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                startGoogleConnect().catch((err) =>
                  setCalendarMsg(`Connect failed — ${err.message}`),
                )
              }
            >
              Connect Calendar
            </button>
          )}
          {googleStatus?.connected && (
            <button
              type="button"
              className="text-xs text-emerald-700 hover:text-emerald-900"
              onClick={async () => {
                await disconnectGoogle();
                setGoogleStatus(await fetchGoogleStatus());
              }}
              title={`Click to disconnect — ${googleStatus.email ?? "connected"}`}
            >
              Calendar: {googleStatus.email ?? "connected"}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void exportWeeklyPlanner(tasks, prefs);
            }}
            title="Download a 7-day Top Three planner as PDF"
            disabled={tasks.length === 0}
          >
            Export PDF
          </button>
          <ModeSwitch mode={prefs.mode} onChange={(mode) => setPrefs({ mode })} />
        </div>
      </header>

      <nav className="flex gap-1 border-b border-slate-200">
        {TAB_DEFS.map((t) => {
          const active = view === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setView(t.key)}
              className={`px-3 py-2 text-sm font-medium transition ${
                active
                  ? "border-b-2 border-slate-900 text-slate-900"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      {calendarMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {calendarMsg}
        </div>
      )}

      {view === "today" && (
        <div className="space-y-8">
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
                  disabled={
                    loading ||
                    tasks.length === 0 ||
                    (source === "claude" && aiResult !== null)
                  }
                  title={
                    source === "claude" && aiResult !== null
                      ? "AI ranking is current — add or change a task to re-run"
                      : "Ask Claude to re-rank Top Three"
                  }
                >
                  {loading
                    ? "Asking Claude…"
                    : source === "claude" && aiResult !== null
                    ? "AI ✓"
                    : "Refresh with AI"}
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
              onComplete={handleTopThreeComplete}
              onSchedule={handleScheduleTask}
              onSnooze={(id, until) => updateTask(id, { snoozedUntil: until })}
              goals={goals}
              calendarConnected={googleStatus?.connected ?? false}
            />
          </section>

          <DaySchedule
            tasks={tasks}
            calendarConnected={googleStatus?.connected ?? false}
            onPushToCalendar={handleScheduleTask}
            onScheduleLocal={(id, isoTime) =>
              updateTask(id, { scheduledFor: isoTime })
            }
            onUnschedule={(id) => updateTask(id, { scheduledFor: undefined })}
          />

          <TomorrowPreview
            prioritized={tomorrowPreview}
            onDoEarly={toggleComplete}
          />
        </div>
      )}

      {view === "tasks" && (
        <div className="space-y-8">
          <section id="task-form-section" className="space-y-3 scroll-mt-4">
            <h2 className="text-lg font-semibold">
              {editingTask ? `Edit "${editingTask.title}"` : "Add tasks"}
            </h2>
            {!editingTask && (
              <PlannerScan tasks={tasks} onApply={applyScanUpdate} />
            )}
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
              onUnsnooze={(id) => updateTask(id, { snoozedUntil: undefined })}
            />
          </section>
        </div>
      )}

      {view === "insights" && (
        <div className="space-y-8">
          <PriorityMatrix tasks={tasks} onEdit={startEdit} />
          <SuggestDates
            tasks={tasks}
            onApply={(id, dueDate) => updateTask(id, { dueDate })}
          />
          <CompanyAssist
            tasks={tasks}
            onUpdateTask={updateTask}
            onAddTask={addTask}
          />
        </div>
      )}

      {view === "goals" && (
        <Goals
          goals={goals}
          taskCountByGoal={taskCountByGoal}
          onAdd={addGoal}
          onUpdate={updateGoal}
          onRemove={removeGoal}
        />
      )}

      <footer className="pt-4 text-center text-xs text-slate-400">
        Local MVP · Calendar via Google · OCR via Tesseract · PDF planner
      </footer>

      {scheduleConfirm && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-lg">
          <p className="mb-2 text-sm">
            <span className="font-medium">"{scheduleConfirm.title}"</span> was
            done late. Should the cycle reset to today, or stay on its original
            day?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => {
                updateTask(scheduleConfirm.taskId, {
                  lastCompletedAt: scheduleConfirm.intendedIso,
                });
                setScheduleConfirm(null);
              }}
              title="Next due date stays on the original schedule"
            >
              Keep original
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => setScheduleConfirm(null)}
              title="Next due date is the recurrence interval from today"
            >
              Reset to today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
