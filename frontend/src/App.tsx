import { useEffect, useMemo, useState } from "react";
import { TaskFormModal } from "@/components/TaskFormModal";
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
import { Achievements } from "@/components/Achievements";
import { WeekSchedule } from "@/components/WeekSchedule";
import { SchedulePicker, type ScheduleChoice } from "@/components/SchedulePicker";
import { PlannerScan, type ResolvedUpdate } from "@/components/PlannerScan";
import { SettingsPanel } from "@/components/SettingsPanel";
import { checkAndNotify } from "@/lib/notifications";
import { downloadBackup, readBackupFile } from "@/lib/backup";
import { useAuth } from "@/lib/useAuth";
import { Login } from "@/components/Login";
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
import { enrichTaskFromCompaniesHouse } from "@/lib/enrichTask";
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
  const auth = useAuth();
  // Auth gate — only render the app once we know the user's signed in (or auth
  // is disabled entirely in single-user / dev mode).
  if (auth.enabled && auth.loading) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }
  if (auth.enabled && !auth.user) {
    return <Login auth={auth} />;
  }
  return <AppShell auth={auth} />;
}

function AppShell({ auth }: { auth: ReturnType<typeof useAuth> }) {
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
    replaceAllTasks,
    replacePrefs,
  } = useTasks();
  const { goals, addGoal, updateGoal, removeGoal, replaceAllGoals } = useGoals();

  const addTaskAndEnrich = (input: Parameters<typeof addTask>[0]) => {
    const task = addTask(input);
    void enrichTaskFromCompaniesHouse(task, updateTask);
    return task;
  };

  // One-time auto-correction: any task with a Companies House lock and a
  // dueDate >30 days out shouldn't be flagged high/critical urgency. The
  // brain-dump AI sets urgency before the filing date is known, so once we
  // have the real date we can relax the flag automatically.
  useEffect(() => {
    for (const t of tasks) {
      if (t.status === "completed") continue;
      if (!t.companyHouseNumber || !t.dueDate) continue;
      if (t.urgency !== "high" && t.urgency !== "critical") continue;
      const daysOut = (new Date(t.dueDate).getTime() - Date.now()) / 86400000;
      if (daysOut > 30) updateTask(t.id, { urgency: "normal" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Per-goal progress: completed tasks linked to the goal in the last 30 days,
  // and the most-recent activity timestamp.
  const goalProgress = useMemo(() => {
    const out = new Map<
      string,
      { doneLast30: number; lastActivityIso?: string }
    >();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const t of tasks) {
      const goalIds = t.goalIds ?? [];
      if (goalIds.length === 0) continue;
      const updated = new Date(t.updatedAt).getTime();
      const lastDone = t.lastCompletedAt
        ? new Date(t.lastCompletedAt).getTime()
        : null;
      const completedRecently =
        t.status === "completed" && updated >= cutoff;
      const recurringDoneRecently = lastDone !== null && lastDone >= cutoff;
      for (const gid of goalIds) {
        const cur = out.get(gid) ?? { doneLast30: 0 };
        if (completedRecently || recurringDoneRecently) cur.doneLast30 += 1;
        const candidateActivity = lastDone ?? updated;
        if (
          !cur.lastActivityIso ||
          candidateActivity > new Date(cur.lastActivityIso).getTime()
        ) {
          cur.lastActivityIso = new Date(candidateActivity).toISOString();
        }
        out.set(gid, cur);
      }
    }
    return out;
  }, [tasks]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [presetGoalIds, setPresetGoalIds] = useState<string[]>([]);
  const editingTask = editingId ? tasks.find((t) => t.id === editingId) : undefined;
  const taskFormOpen = Boolean(editingTask) || addingNew;
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
  const [pickerForTaskId, setPickerForTaskId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showBrainDump, setShowBrainDump] = useState(false);
  const [showPlannerScan, setShowPlannerScan] = useState(false);
  const taskBeingScheduled = pickerForTaskId
    ? tasks.find((t) => t.id === pickerForTaskId)
    : undefined;

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

  // Notification ticker — runs every minute when the user has opted in.
  useEffect(() => {
    if (!prefs.notificationsEnabled) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const id = setInterval(() => checkAndNotify(tasks), 60 * 1000);
    // Also check immediately on mount / when tasks change.
    checkAndNotify(tasks);
    return () => clearInterval(id);
  }, [tasks, prefs.notificationsEnabled]);

  useEffect(() => {
    fetchGoogleStatus().then(setGoogleStatus).catch(() => setGoogleStatus(null));
    // If we just returned from the OAuth round-trip, surface a confirmation.
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      setCalendarMsg("Google Calendar connected.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const openSchedulePicker = (taskId: string) => {
    setCalendarMsg(null);
    setPickerForTaskId(taskId);
  };

  const confirmSchedule = async (choice: ScheduleChoice) => {
    if (!taskBeingScheduled) {
      setPickerForTaskId(null);
      return;
    }
    const task = taskBeingScheduled;
    setPickerForTaskId(null);

    if (choice.destination === "local") {
      // Local-only schedule: clear any prior Google link and set scheduledFor.
      updateTask(task.id, {
        scheduledFor: choice.start.toISOString(),
        calendarEventId: undefined,
      });
      setCalendarMsg(
        `"${task.title}" scheduled locally for ${choice.start.toLocaleString()}.`,
      );
      return;
    }

    if (!googleStatus?.connected) {
      setCalendarMsg(
        googleStatus?.configured
          ? "Connect Google Calendar first (header → Connect Calendar)."
          : "Calendar isn't set up yet — see the README for Google Cloud OAuth steps.",
      );
      return;
    }
    try {
      const { eventId, htmlLink } = await scheduleTask(task, choice.start, choice.end);
      // Pushed to Google — store the real event id so we can delete it later.
      // Clear scheduledFor so it doesn't show twice (Google fetch will surface it).
      updateTask(task.id, {
        calendarEventId: eventId,
        scheduledFor: undefined,
      });
      setCalendarMsg(
        htmlLink
          ? `Pushed "${task.title}" to Google — opening Calendar`
          : `Pushed "${task.title}" to Google Calendar.`,
      );
      if (htmlLink) window.open(htmlLink, "_blank", "noopener,noreferrer");
    } catch (err) {
      const reason =
        err instanceof CalendarError ? err.message : "unexpected error";
      setCalendarMsg(`Couldn't push to Google — ${reason}`);
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
    setAddingNew(false);
    setEditingId(id);
  };
  const startNew = () => {
    setEditingId(null);
    setPresetGoalIds([]);
    setAddingNew(true);
  };
  const startNewForGoal = (goalId: string) => {
    setEditingId(null);
    setPresetGoalIds([goalId]);
    setAddingNew(true);
  };
  const closeTaskForm = () => {
    setEditingId(null);
    setAddingNew(false);
    setPresetGoalIds([]);
  };

  const local = useMemo(
    () => prioritize(tasks, { prefs, limit: 3, goals }),
    [tasks, prefs, goals],
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
    return prioritize(tasks, { prefs, limit: 3, now: tomorrow, goals }).filter(
      (p) => !todaysIds.has(p.task.id),
    );
  }, [tasks, prefs, tomorrow, local, goals]);

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
              className="text-xs text-amber-700"
              title="Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env. See README."
            >
              Calendar: setup needed
            </span>
          )}
          {/* Header Connect button — show whenever NOT connected, even before
              the status fetch completes, so it never disappears on a slow or
              failed /api/google/status call. Errors land in calendarMsg below
              the nav for visibility outside the Settings modal. */}
          {!googleStatus?.connected && googleStatus?.configured !== false && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                startGoogleConnect().catch((err) =>
                  setCalendarMsg(
                    `Connect failed — ${err instanceof Error ? err.message : String(err)}`,
                  ),
                )
              }
            >
              Connect Calendar
            </button>
          )}
          {googleStatus?.connected && (
            <a
              href="https://calendar.google.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-emerald-700 hover:text-emerald-900 hover:underline"
              title={`${googleStatus.email ?? "connected"} — open Google Calendar in a new tab. To disconnect, see Settings.`}
            >
              Calendar: {googleStatus.email ?? "connected"} ↗
            </a>
          )}
          <ModeSwitch mode={prefs.mode} onChange={(mode) => setPrefs({ mode })} />
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-900"
            onClick={() => setShowSettings(true)}
            title="Working hours, days, notifications"
          >
            ⚙ Settings
          </button>
          {auth.enabled && auth.user && (
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-slate-900"
              onClick={() => void auth.signOut()}
              title={auth.user.email ?? "Sign out"}
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      <nav className="flex items-center gap-1 border-b border-slate-200">
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
        <div className="ml-auto flex items-center gap-1.5 pr-1">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => {
              void exportWeeklyPlanner(tasks, prefs);
            }}
            title="Download a 7-day Top Three planner as PDF"
            disabled={tasks.length === 0}
          >
            Export PDF
          </button>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => setShowPlannerScan(true)}
            title="Scan a marked-up planner photo back into the app"
            disabled={tasks.length === 0}
          >
            📥 Scan
          </button>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => setShowBrainDump(true)}
            title="Paste a list and let Claude parse it into tasks"
          >
            ✨ Brain dump
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={startNew}
            title="Add a single task"
          >
            + Task
          </button>
        </div>
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
              onSchedule={openSchedulePicker}
              onSnooze={(id, until) => updateTask(id, { snoozedUntil: until })}
              goals={goals}
              calendarConnected={googleStatus?.connected ?? false}
            />
          </section>

          <WeekSchedule
            tasks={tasks}
            prefs={prefs}
            calendarConnected={googleStatus?.connected ?? false}
            onScheduleClick={openSchedulePicker}
            onUnschedule={(id) => updateTask(id, { scheduledFor: undefined })}
            onSetSessionTimes={(id, isoTimes) =>
              updateTask(id, { sessionTimes: isoTimes })
            }
            onMoveTask={(id, newIso) =>
              updateTask(id, { scheduledFor: newIso })
            }
            onMoveSession={(id, oldIso, newIso) => {
              const t = tasks.find((x) => x.id === id);
              if (!t || !t.sessionTimes) return;
              const next = t.sessionTimes.map((iso) =>
                iso === oldIso ? newIso : iso,
              );
              updateTask(id, { sessionTimes: next });
            }}
            onShadowEvent={(ev) => {
              if (!ev.start) return;
              const start = new Date(ev.start);
              const end = ev.end
                ? new Date(ev.end)
                : new Date(start.getTime() + 60 * 60 * 1000);
              const minutes = Math.max(
                15,
                Math.round((end.getTime() - start.getTime()) / 60000),
              );
              addTask({
                title: ev.summary || "Calendar block",
                description: ev.calendarName
                  ? `Imported from ${ev.calendarName} — won't sync back to Google.`
                  : "Imported from Google Calendar — won't sync back.",
                theme: "personal",
                estimatedMinutes: minutes,
                urgency: "normal",
                privacy: "private",
                isWork: false,
                isBlocker: false,
                blockedBy: [],
                recurrence: "none",
                timeOfDay: "anytime",
                scheduledFor: start.toISOString(),
              });
              setCalendarMsg(
                `"${ev.summary || "Calendar block"}" added to your schedule. It won't sync to Google.`,
              );
            }}
          />

          <TomorrowPreview
            prioritized={tomorrowPreview}
            onDoEarly={toggleComplete}
          />
        </div>
      )}

      {view === "tasks" && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">All tasks</h2>
          <TaskList
            tasks={tasks}
            onToggle={toggleComplete}
            onRemove={removeTask}
            onEdit={startEdit}
            onUnsnooze={(id) => updateTask(id, { snoozedUntil: undefined })}
            onSchedule={openSchedulePicker}
          />
        </section>
      )}

      {view === "insights" && (
        <div className="space-y-8">
          <Achievements tasks={tasks} goals={goals} />
          <PriorityMatrix tasks={tasks} onEdit={startEdit} />
          <SuggestDates
            tasks={tasks}
            onApply={(id, dueDate) => updateTask(id, { dueDate })}
          />
          <CompanyAssist
            tasks={tasks}
            onUpdateTask={updateTask}
            onAddTask={addTaskAndEnrich}
          />
        </div>
      )}

      {view === "goals" && (
        <Goals
          goals={goals}
          tasks={tasks}
          taskCountByGoal={taskCountByGoal}
          progressByGoal={goalProgress}
          onAdd={addGoal}
          onUpdate={updateGoal}
          onRemove={removeGoal}
          onAddTaskForGoal={startNewForGoal}
          onLinkTaskToGoal={(taskId, goalId) => {
            const t = tasks.find((x) => x.id === taskId);
            if (!t) return;
            const cur = t.goalIds ?? [];
            if (cur.includes(goalId)) return;
            updateTask(taskId, { goalIds: [...cur, goalId] });
          }}
          onUnlinkTaskFromGoal={(taskId, goalId) => {
            const t = tasks.find((x) => x.id === taskId);
            if (!t) return;
            const cur = t.goalIds ?? [];
            if (!cur.includes(goalId)) return;
            updateTask(taskId, {
              goalIds: cur.filter((id) => id !== goalId),
            });
          }}
        />
      )}

      <footer className="pt-4 text-center text-xs text-slate-400">
        Local MVP · Calendar via Google · OCR via Tesseract · PDF planner
      </footer>

      {taskBeingScheduled && (
        <SchedulePicker
          task={taskBeingScheduled}
          calendarConnected={googleStatus?.connected ?? false}
          onConfirm={confirmSchedule}
          onCancel={() => setPickerForTaskId(null)}
        />
      )}

      {taskFormOpen && (
        <TaskFormModal
          initialTask={editingTask}
          goals={goals}
          presetGoalIds={presetGoalIds}
          onSubmit={(input) => {
            if (editingTask) {
              updateTask(editingTask.id, input);
            } else {
              addTaskAndEnrich(input);
            }
          }}
          onClose={closeTaskForm}
        />
      )}

      {showBrainDump && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 px-4 py-8"
          onClick={() => setShowBrainDump(false)}
        >
          <div
            className="w-full max-w-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <BrainDump
              defaultOpen
              onAdd={addTaskAndEnrich}
              onClose={() => setShowBrainDump(false)}
              userType={prefs.userType}
            />
          </div>
        </div>
      )}

      {showPlannerScan && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 px-4 py-8"
          onClick={() => setShowPlannerScan(false)}
        >
          <div
            className="w-full max-w-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <PlannerScan
              defaultOpen
              tasks={tasks}
              onApply={applyScanUpdate}
              onClose={() => setShowPlannerScan(false)}
            />
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          prefs={prefs}
          onChange={setPrefs}
          onClose={() => setShowSettings(false)}
          onExport={() => downloadBackup(tasks, goals, prefs)}
          onImport={async (file) => {
            const bundle = await readBackupFile(file);
            replaceAllTasks(bundle.tasks);
            replaceAllGoals(bundle.goals);
            replacePrefs(bundle.prefs);
          }}
          calendar={{
            // Default to "configured + not connected" until the status
            // fetch comes back, so the Connect Calendar button is always
            // visible — never gets hidden by a slow or failed status check.
            configured: googleStatus?.configured ?? true,
            connected: googleStatus?.connected ?? false,
            email: googleStatus?.email ?? null,
            // Re-throw so SettingsPanel can render the error inline (the
            // global `calendarMsg` banner sits behind the modal).
            onConnect: () => startGoogleConnect(),
            onDisconnect: async () => {
              await disconnectGoogle();
              setGoogleStatus(await fetchGoogleStatus());
            },
          }}
        />
      )}

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
