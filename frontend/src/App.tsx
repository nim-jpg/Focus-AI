import { useEffect, useMemo, useRef, useState } from "react";
import { TaskFormModal } from "@/components/TaskFormModal";
import { TaskList } from "@/components/TaskList";
import { SuggestedGoalLinks } from "@/components/SuggestedGoalLinks";
import { UnmappedTasks } from "@/components/UnmappedTasks";
import { SmartActionsBar } from "@/components/SmartActionsBar";
import { TopThree } from "@/components/TopThree";
import { SlippedTasks, findSlippedTasks } from "@/components/SlippedTasks";
import { ModeSwitch } from "@/components/ModeSwitch";
import { isInWorkMode } from "@/lib/modeFilter";
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
import {
  loadAiCache,
  saveAiCache,
  syncAiCacheFromRemote,
} from "@/lib/storage";
import { isAuthEnabled } from "@/lib/supabaseClient";
import { logEvent as logMetricEvent } from "@/lib/metrics";
import { useAuth } from "@/lib/useAuth";
import { Login } from "@/components/Login";
import { useGoals } from "@/lib/useGoals";
import { useTasks } from "@/lib/useTasks";
import { prioritize } from "@/lib/prioritize";
import { aiPrioritize, AiUnavailableError } from "@/lib/aiPrioritize";
import {
  intendedScheduleDate,
  isFoundation,
  isDueNow,
  wasCompletedLate,
  wasCompletedToday,
} from "@/lib/recurrence";
import { exportWeeklyPlanner } from "@/lib/pdfPlanner";
import { enrichTaskFromCompaniesHouse } from "@/lib/enrichTask";
import {
  CalendarError,
  disconnectGoogle,
  fetchGoogleStatus,
  patchEventTime,
  runAutoSync,
  scheduleTask,
  startGoogleConnect,
  type AutoSyncResult,
  type GoogleStatus,
} from "@/lib/googleCalendar";
import { IosShell } from "@/components/ios/IosShell";
import type { PrioritizedTask, Task } from "@/types/task";

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
    markCompletedOn,
    incrementCounter,
    markSurfaced,
    setPrefs,
    replaceAllTasks,
    replacePrefs,
    refreshFromRemote,
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

  /**
   * Outcome-aware close. Records resolution metadata on the task and, when
   * course-correcting, spawns a follow-up that inherits the original's goal
   * links + theme. The follow-up holds a backref via followUpToTaskId so we
   * can build a "perseverance lineage" view later.
   *
   * Note: we deliberately set resolution BEFORE toggling complete, so the
   * resolved task carries the metadata at the moment of completion. Recurring
   * tasks get the resolution applied to the current instance's snapshot.
   */
  const handleResolveTask = (
    id: string,
    resolution: "achieved" | "course-corrected" | "accepted",
    opts?: { note?: string; followUp?: { title: string } },
  ) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    updateTask(id, {
      resolution,
      resolutionNote: opts?.note,
      resolutionAt: new Date().toISOString(),
    });
    if (resolution === "course-corrected" && opts?.followUp?.title) {
      const followUp = addTask({
        title: opts.followUp.title,
        theme: task.theme,
        urgency: task.urgency,
        privacy: task.privacy,
        isWork: task.isWork,
        isBlocker: false,
        recurrence: "none",
        status: "pending",
        goalIds: task.goalIds ? [...task.goalIds] : undefined,
        kind: "follow-up",
        followUpToTaskId: id,
      });
      updateTask(id, { followUpTaskIds: [...(task.followUpTaskIds ?? []), followUp.id] });
    }
    handleTopThreeComplete(id);
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

  // Theme — write data-theme on <html> so the dark-mode override block in
  // index.css can flip the desktop palette (and browser color-scheme adjusts
  // form controls + scrollbars). Defaults to light when no pref is set so
  // existing users don't get an unexpected dark surprise; explicit "dark"
  // flips. The iOS shell scopes its own theme on .ios-root[data-theme=...]
  // independently.
  useEffect(() => {
    const theme = prefs.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [prefs.theme]);

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
      // If the task is already linked to a Google event, delete it first so
      // re-scheduling produces ONE event at the new time, not a leftover at
      // the old time plus a fresh one. Pass the source calendarId so the
      // delete hits the right calendar — events imported from a non-primary
      // calendar (shared / family) need explicit targeting; otherwise the
      // delete silently 404s and the original event survives.
      if (task.calendarEventId) {
        try {
          const { deleteEvent } = await import("@/lib/googleCalendar");
          await deleteEvent(task.calendarEventId, task.calendarId);
        } catch {
          // If the old event is already gone, fine — push the new one anyway.
        }
      }
      const { eventId } = await scheduleTask(task, choice.start, choice.end, {
        weeklyRecurring: choice.weeklyRecurring,
      });
      // Pushed to Google — store the real event id so we can delete it later.
      // Clear scheduledFor so it doesn't show twice (Google fetch will surface it).
      updateTask(task.id, {
        calendarEventId: eventId,
        scheduledFor: undefined,
      });
      logMetricEvent("calendar_event_pushed", {
        theme: task.theme,
        weeklyRecurring: choice.weeklyRecurring ?? false,
      });
      setCalendarMsg(
        `"${task.title}" added to your personal calendar.`,
      );
    } catch (err) {
      const reason =
        err instanceof CalendarError ? err.message : "unexpected error";
      setCalendarMsg(`Couldn't push to Google — ${reason}`);
    }
  };
  // Scan-back undo: captures the BEFORE-state of each task that the
  // current scan session touches. Committed to localStorage on
  // PlannerScan close, so the user can revert the whole session in one
  // click from Settings.
  const SCAN_UNDO_KEY = "focus3:lastScanUndo:v1";
  type ScanUndoEntry = {
    taskId: string;
    fields: Partial<Task>;
  };
  const scanBufferRef = useRef<ScanUndoEntry[]>([]);
  const [lastScanUndo, setLastScanUndo] = useState<{
    ts: number;
    items: ScanUndoEntry[];
  } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(SCAN_UNDO_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const persistScanUndo = (
    next: { ts: number; items: ScanUndoEntry[] } | null,
  ) => {
    setLastScanUndo(next);
    try {
      if (next) localStorage.setItem(SCAN_UNDO_KEY, JSON.stringify(next));
      else localStorage.removeItem(SCAN_UNDO_KEY);
    } catch {
      /* ignore */
    }
  };

  const applyScanUpdate = (u: ResolvedUpdate) => {
    // Snapshot the relevant fields BEFORE applying so we can revert.
    const t = tasks.find((x) => x.id === u.taskId);
    if (t) {
      const snapshot: Partial<Task> = {
        status: t.status,
        snoozedUntil: t.snoozedUntil,
        estimatedMinutes: t.estimatedMinutes,
        title: t.title,
        lastCompletedAt: t.lastCompletedAt,
      };
      scanBufferRef.current.push({ taskId: u.taskId, fields: snapshot });
    }
    switch (u.action) {
      case "complete": {
        // Ignore complete-marks on tasks whose date is still in the
        // future. The user might tick a future-week column by accident,
        // or scan an old planner where a tick now refers to a slot
        // that's already been re-scheduled. Past + current marks
        // continue the streak as expected.
        const t = tasks.find((x) => x.id === u.taskId);
        const target = t?.scheduledFor ?? t?.dueDate;
        if (target && new Date(target).getTime() > Date.now()) break;
        toggleComplete(u.taskId);
        break;
      }
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
      case "habitTick": {
        // value can be { day, count? } from Claude. For counter habits
        // we increment by count; for non-counter we mark complete on
        // the appropriate past day. Future days within this week are
        // ignored — user might tick ahead by accident.
        const t = tasks.find((x) => x.id === u.taskId);
        if (!t) break;
        const v = (typeof u.value === "object" && u.value !== null
          ? u.value
          : {}) as { day?: string; count?: number };
        // Resolve day name → date within the current calendar week. If the
        // resolved date is in the future, skip the tick entirely.
        const dayMap: Record<string, number> = {
          Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
        };
        const targetDow = v.day ? dayMap[v.day] : undefined;
        let targetDate: Date | null = null;
        if (typeof targetDow === "number") {
          const today = new Date();
          today.setHours(12, 0, 0, 0); // midday avoids DST edge cases
          const todayDow = today.getDay();
          // Walk back to the most recent occurrence of targetDow (today or earlier).
          // diff >= 0 means days BACK from today.
          const diff = (todayDow - targetDow + 7) % 7;
          targetDate = new Date(today);
          targetDate.setDate(today.getDate() - diff);
          // If the day name implies a future date this week (i.e. the
          // tick crossed midnight forward), skip.
          if (targetDate.getTime() > Date.now()) break;
        }
        const isCounter = Boolean(t.counter && t.counter.target > 0);
        if (isCounter) {
          incrementCounter(u.taskId, Math.max(1, Math.round(v.count ?? 1)));
        } else if (targetDate) {
          markCompletedOn(u.taskId, targetDate.toISOString());
        } else {
          // No day specified — default to today.
          toggleComplete(u.taskId);
        }
        break;
      }
      case "newNote": {
        // Append the note to the task's description (or create a fresh
        // task if no target was matched). For now: if a taskId was
        // resolved, append; otherwise just surface the note in the
        // calendar message and let the user copy-paste it where they want.
        const text =
          typeof u.value === "string" ? u.value.trim() : "";
        if (!text) break;
        if (u.taskId) {
          const t = tasks.find((x) => x.id === u.taskId);
          if (t) {
            updateTask(u.taskId, {
              description: t.description
                ? `${t.description}\n\nFrom planner: ${text}`
                : `From planner: ${text}`,
            });
          }
        } else {
          setCalendarMsg(`Note from planner: "${text}"`);
        }
        break;
      }
      case "createTask": {
        const v =
          typeof u.value === "object" && u.value !== null
            ? (u.value as {
                title?: string;
                theme?: string;
                dueDate?: string;
                urgency?: string;
              })
            : { title: typeof u.value === "string" ? u.value : undefined };
        const title = (v.title ?? "").trim();
        if (!title) break;
        const safeTheme = (
          [
            "work",
            "projects",
            "personal",
            "school",
            "fitness",
            "finance",
            "diet",
            "medication",
            "development",
            "household",
          ] as const
        ).includes((v.theme ?? "personal") as never)
          ? ((v.theme ?? "personal") as Task["theme"])
          : "personal";
        const safeUrgency = (
          ["low", "normal", "high", "critical"] as const
        ).includes((v.urgency ?? "normal") as never)
          ? ((v.urgency ?? "normal") as Task["urgency"])
          : "normal";
        addTask({
          title,
          theme: safeTheme,
          urgency: safeUrgency,
          privacy: "private",
          recurrence: "none",
          isWork: safeTheme === "work",
          isBlocker: false,
          blockedBy: [],
          estimatedMinutes: 30,
          timeOfDay: "anytime",
          dueDate: v.dueDate
            ? new Date(`${v.dueDate}T00:00:00`).toISOString()
            : undefined,
          description: "Created from PDF planner notes.",
        });
        break;
      }
      case "createGoal": {
        const v =
          typeof u.value === "object" && u.value !== null
            ? (u.value as { title?: string; horizon?: string; theme?: string })
            : { title: typeof u.value === "string" ? u.value : undefined };
        const title = (v.title ?? "").trim();
        if (!title) break;
        const safeHorizon = (["6m", "1y", "5y", "10y"] as const).includes(
          (v.horizon ?? "1y") as never,
        )
          ? ((v.horizon ?? "1y") as "6m" | "1y" | "5y" | "10y")
          : "1y";
        const safeTheme = (
          [
            "work",
            "projects",
            "personal",
            "school",
            "fitness",
            "finance",
            "diet",
            "medication",
            "development",
            "household",
          ] as const
        ).includes((v.theme ?? "personal") as never)
          ? ((v.theme ?? "personal") as Task["theme"])
          : "personal";
        addGoal({
          title,
          horizon: safeHorizon,
          theme: safeTheme,
          notes: "Created from PDF planner notes.",
        });
        break;
      }
    }
  };

  const commitScanSession = () => {
    if (scanBufferRef.current.length === 0) return;
    persistScanUndo({
      ts: Date.now(),
      items: scanBufferRef.current.slice(),
    });
    scanBufferRef.current = [];
  };

  const undoLastScan = () => {
    if (!lastScanUndo) return;
    for (const entry of lastScanUndo.items) {
      updateTask(entry.taskId, entry.fields);
    }
    persistScanUndo(null);
    setCalendarMsg(
      `Undid ${lastScanUndo.items.length} scan-back change${lastScanUndo.items.length === 1 ? "" : "s"}.`,
    );
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
    () =>
      tasks.filter((t) => {
        if (!isFoundation(t)) return false;
        if (t.status === "completed") return false;
        // A non-daily foundation deferred via snoozedUntil hides until
        // that time passes — the user wanted "skip just for today" on
        // weekly/monthly foundations without breaking their streak.
        if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) {
          return false;
        }
        return true;
      }),
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

  // aiCache: Claude's tier + reasoning for tasks we've already ranked,
  // plus a hash of the ranking-relevant fields per task so we know when
  // to re-rank. Survives task additions/removals — we just merge new
  // tasks in incrementally instead of wiping and starting over.
  type CachedRank = {
    tier: 1 | 2 | 3 | 4;
    reasoning: string;
    /** Hash of fields that influence ranking. Mismatch ⇒ re-rank. */
    hash: string;
  };
  // aiCache survives page reloads AND ports between devices when signed in.
  // Stored as { ranks: [[id, entry]...] } locally and as a single jsonb row
  // per user in Supabase via /api/store/ai-cache.
  const [aiCache, setAiCache] = useState<Map<string, CachedRank>>(() => {
    if (typeof window === "undefined") return new Map();
    const cached = loadAiCache();
    if (!cached) return new Map();
    return new Map(cached.ranks as Array<[string, CachedRank]>);
  });
  // Mirror the sync-gate pattern from useTasks: don't push the empty initial
  // map until the backend GET has had a chance to seed it from the canonical
  // copy. Otherwise device 2 would PUT {} and wipe the user's last AI run.
  const aiCacheSynced = useRef(!isAuthEnabled());
  useEffect(() => {
    if (!aiCacheSynced.current) return;
    saveAiCache({ ranks: [...aiCache.entries()] });
  }, [aiCache]);
  useEffect(() => {
    if (!isAuthEnabled()) return;
    let cancelled = false;
    void syncAiCacheFromRemote().then((remote) => {
      if (cancelled) return;
      if (remote) {
        setAiCache(new Map(remote.ranks as Array<[string, CachedRank]>));
        // If the synced cache is non-empty, restore the AI source view.
        if (remote.ranks.length > 0) setSource("claude");
      }
      aiCacheSynced.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Source tracks whether we're currently DISPLAYING the AI ranking. Initial
  // value uses the cache that was already loaded synchronously above.
  const [source, setSource] = useState<Source>(() => {
    if (typeof window === "undefined") return "local";
    const cached = loadAiCache();
    return cached && cached.ranks.length > 0 ? "claude" : "local";
  });
  const [loading, setLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // Bumped each time an AI refresh completes — TaskList watches this to
  // auto-switch its sort to AI rank when fresh ranks land.
  const [aiRefreshTick, setAiRefreshTick] = useState(0);

  const hashTaskForRanking = (t: Task): string =>
    [
      t.title,
      t.theme,
      t.urgency,
      t.dueDate ?? "",
      t.isBlocker ? "1" : "0",
      t.recurrence,
      t.avoidanceWeeks ?? 0,
      (t.goalIds ?? []).slice().sort().join("|"),
      t.estimatedMinutes ?? 30,
      (t.description ?? "").slice(0, 120),
    ].join("§");

  // Filter the cached AI ranking to the current mode and slice to the
  // visible Top Three. When a Top Three task is completed it drops out
  // automatically and the next-ranked task slides up. Pure local re-filter,
  // no AI call. Stretch goals live in the PDF, not the home page.
  const filteredAiResult = useMemo<PrioritizedTask[] | null>(() => {
    if (aiCache.size === 0) return null;
    const mode = prefs.mode;
    const userType = prefs.userType;
    const ranked: PrioritizedTask[] = [];
    for (const t of tasks) {
      if (t.status === "completed") continue;
      const cached = aiCache.get(t.id);
      if (!cached) continue;
      if (mode !== "both") {
        const isWorkBucket = isInWorkMode(t, userType);
        if (mode === "work" && !isWorkBucket) continue;
        if (mode === "personal" && isWorkBucket) continue;
      }
      ranked.push({
        task: t,
        tier: cached.tier,
        reasoning: cached.reasoning,
        score: 0,
      });
    }
    ranked.sort((a, b) => a.tier - b.tier);
    return ranked.slice(0, 3);
  }, [aiCache, tasks, prefs.mode, prefs.userType]);

  const prioritized =
    source === "claude" && filteredAiResult && filteredAiResult.length > 0
      ? filteredAiResult
      : local;

  // Slim view of the AI cache for components that just need taskId → tier
  // (e.g. TaskList sort, PDF stretch picker).
  const aiTierMap = useMemo<Map<string, 1 | 2 | 3 | 4>>(() => {
    const m = new Map<string, 1 | 2 | 3 | 4>();
    for (const [id, entry] of aiCache) m.set(id, entry.tier);
    return m;
  }, [aiCache]);

  // How many open candidate tasks have been edited since their cached AI
  // rank was computed? Surfaced as a "stale" badge on the Refresh button so
  // the user knows when the displayed ranking is out of date.
  const aiStaleCount = useMemo(() => {
    if (aiCache.size === 0) return 0;
    let stale = 0;
    for (const t of tasks) {
      if (t.status === "completed") continue;
      const cached = aiCache.get(t.id);
      if (!cached) continue; // new task — not "stale", just unranked
      if (cached.hash !== hashTaskForRanking(t)) stale++;
    }
    return stale;
    // hashTaskForRanking is stable (declared inline in component but no
    // captured deps that change per render); intentionally not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiCache, tasks]);

  // When the visible Top Three changes, stamp those tasks as surfaced. The hook
  // also auto-bumps avoidanceWeeks when 7+ days have passed without action.
  const surfacedFingerprint = prioritized.map((p) => p.task.id).join(",");
  useEffect(() => {
    if (prioritized.length === 0) return;
    markSurfaced(prioritized.map((p) => p.task.id));
    // intentionally only depend on the fingerprint string, not the array identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfacedFingerprint]);

  /**
   * Sync-only: runAutoSync (Google → tasks + writeback) → refresh the
   * local task cache so newly-imported tasks appear immediately. AI
   * re-rank is intentionally NOT chained — the user triggers that
   * separately via "Refresh AI" on the Top Three card. Reasons:
   *   1. Cost shape — auto-sync is cheap per-call (one Claude pass per
   *      14-day window), AI rerank is the expensive feature, and they
   *      have different cap policies.
   *   2. The 2x/day cap on /api/prioritize would silently waste a slot
   *      every time the user hit Sync, even when they didn't want a
   *      re-rank.
   *   3. Newly-imported tasks land in the heuristic engine immediately
   *      anyway; AI ranking is the cherry on top, not a prerequisite.
   */
  const handleAutoSync = async (): Promise<AutoSyncResult> => {
    // Pass the user's persisted Skip list AND the calendars they've
    // marked as excluded — neither should be touched by enrichment.
    const r = await runAutoSync(
      14,
      prefs.enrichmentSkippedEventIds ?? [],
      prefs.excludedCalendarIds ?? [],
    );
    if (r.imported > 0) {
      await refreshFromRemote();
    }
    return r;
  };

  const handleAiRefresh = async () => {
    setLoading(true);
    setAiError(null);
    try {
      // Incremental: only ask AI about tasks that are NEW or whose
      // ranking-relevant fields have changed since the cached rank.
      const candidates = tasks.filter((t) => {
        if (t.status === "completed") return false;
        if (isFoundation(t)) return false;
        if (t.recurrence !== "none" && !isDueNow(t, new Date())) return false;
        if (
          t.snoozedUntil &&
          new Date(t.snoozedUntil).getTime() > Date.now()
        ) {
          return false;
        }
        return true;
      });
      const toRank = candidates.filter((t) => {
        const cached = aiCache.get(t.id);
        return !cached || cached.hash !== hashTaskForRanking(t);
      });
      // Existing entries that the AI should respect when slotting new ones.
      const existingForContext = candidates
        .filter((t) => {
          const cached = aiCache.get(t.id);
          return cached && cached.hash === hashTaskForRanking(t);
        })
        .map((t) => {
          const cached = aiCache.get(t.id)!;
          return {
            id: t.id,
            title: t.title,
            theme: t.theme,
            urgency: t.urgency,
            dueDate: t.dueDate,
            tier: cached.tier,
          };
        });

      // If nothing new to rank AND we already have a cache, no AI call.
      if (toRank.length === 0 && aiCache.size > 0) {
        setSource("claude");
        return;
      }

      const newRanks = await aiPrioritize(toRank, prefs, existingForContext);

      // Apply any urgency patches the model suggested. Skip cases where
      // the model echoed the existing value or the task no longer exists.
      for (const r of newRanks) {
        if (!r.suggestedUrgency) continue;
        if (r.suggestedUrgency === r.task.urgency) continue;
        updateTask(r.task.id, { urgency: r.suggestedUrgency });
      }

      // Belt-and-braces year-out heuristic: anything still high/critical
      // with a dueDate >180 days out gets relaxed to "normal" — even if
      // Claude didn't suggest it. Skip tasks the user has manually flagged
      // as a blocker (intentional escalation).
      for (const t of candidates) {
        if (t.urgency !== "high" && t.urgency !== "critical") continue;
        if (t.isBlocker) continue;
        if (!t.dueDate) continue;
        const daysOut =
          (new Date(t.dueDate).getTime() - Date.now()) / 86400000;
        if (daysOut > 180) updateTask(t.id, { urgency: "normal" });
      }

      setAiCache((prev) => {
        const next = new Map(prev);
        // Drop entries for tasks that no longer exist (deleted/completed).
        const liveIds = new Set(candidates.map((t) => t.id));
        for (const id of next.keys()) {
          if (!liveIds.has(id)) next.delete(id);
        }
        // Merge in fresh ranks with their hash.
        for (const r of newRanks) {
          next.set(r.task.id, {
            tier: r.tier,
            reasoning: r.reasoning,
            hash: hashTaskForRanking(r.task),
          });
        }
        return next;
      });
      setSource("claude");
      // Notify any listeners (e.g. TaskList) to switch their sort to AI rank.
      setAiRefreshTick((t) => t + 1);
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

  // iOS layout — opt-in via prefs.iosLayout OR ?ui=ios in the URL.
  // Same data hooks, same backend; just a different shell.
  const useIosLayout =
    prefs.iosLayout === true ||
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("ui") === "ios");
  if (useIosLayout) {
    return (
      <IosShell
        tasks={tasks}
        goals={goals}
        prefs={prefs}
        prioritized={prioritized}
        foundations={foundations}
        aiTierMap={aiTierMap}
        onComplete={(id) => handleTopThreeComplete(id)}
        onResolve={handleResolveTask}
        onSetScheduledFor={(taskId, iso) => updateTask(taskId, { scheduledFor: iso })}
        onUpdateEstimatedMinutes={(taskId, minutes) => updateTask(taskId, { estimatedMinutes: minutes })}
        onUpdateTask={updateTask}
        onMuteEvent={(eventId) => {
          const cur = prefs.ignoredEventIds ?? [];
          if (cur.includes(eventId)) return;
          setPrefs({ ignoredEventIds: [...cur, eventId] });
        }}
        onToggleTask={toggleComplete}
        onRemoveTask={removeTask}
        onEditTask={startEdit}
        onSchedule={openSchedulePicker}
        onUnsnooze={(id) => updateTask(id, { snoozedUntil: undefined })}
        onSnooze={(id, until) => updateTask(id, { snoozedUntil: until })}
        onIncrementCounter={incrementCounter}
        onDeferFoundation={(id) => {
          const until = new Date();
          until.setDate(until.getDate() + 1);
          updateTask(id, { snoozedUntil: until.toISOString() });
        }}
        onUpdatePrefs={setPrefs}
        onAddGoal={addGoal}
        onUpdateGoal={updateGoal}
        onRemoveGoal={removeGoal}
        onAddTask={() => startNew()}
        onBrainDump={() => setShowBrainDump(true)}
        taskCountByGoal={taskCountByGoal}
        goalProgress={goalProgress}
        calendarConnected={googleStatus?.connected ?? false}
        onRefreshAi={handleAiRefresh}
        aiBusy={loading}
        aiRefreshTick={aiRefreshTick}
        onExitIosLayout={() => setPrefs({ iosLayout: false })}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:space-y-8 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        {/* LEFT — brand mark + Focus3 wordmark side-by-side on the same
            line, motto sits underneath the wordmark (NOT alongside
            the icon, so the icon and title visually pair as one unit). */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-slate-900 shadow-md shadow-slate-900/20"
            >
              <div className="flex gap-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
              </div>
            </div>
            <h1 className="bg-gradient-to-br from-slate-900 to-slate-700 bg-clip-text text-xl font-bold tracking-tight text-transparent sm:text-2xl">
              Focus3
            </h1>
          </div>
          <p className="text-xs text-slate-500 sm:text-sm">
            Three things, every day. Your non-negotiables, surfaced.
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {/* Compact calendar status: "Calendar 🔗" connected (click → open
              Google Calendar) or "Calendar ⛓️‍💥" not connected (click → start
              OAuth). Disconnect lives in Settings. */}
          {googleStatus?.connected ? (
            <a
              href="https://calendar.google.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900 hover:underline"
              title="Connected — open Google Calendar in a new tab. To disconnect, see Settings."
            >
              calendar link
              <span aria-hidden>🔗</span>
            </a>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
              onClick={() =>
                startGoogleConnect().catch((err) =>
                  setCalendarMsg(
                    `Connect failed — ${err instanceof Error ? err.message : String(err)}`,
                  ),
                )
              }
              title={
                googleStatus && !googleStatus.configured
                  ? "Google OAuth isn't configured on the server"
                  : "Click to connect Google Calendar"
              }
            >
              calendar link
              <span aria-hidden>⛓️‍💥</span>
            </button>
          )}
          {/* Mode switch (Both / Projects / Personal) moved out of this
              row; now sits on the right of the tabs row beneath. */}
          {/* Theme toggle — sun/moon icon, mirrors the iOS shell control.
              Persists on prefs so the choice follows the user across
              surfaces. Currently only the iOS shell honours the theme
              fully; the desktop layout tracks it for future work. */}
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900"
            onClick={() =>
              setPrefs({
                theme: prefs.theme === "light" ? "dark" : "light",
              })
            }
            title={
              prefs.theme === "light"
                ? "Switch to dark theme"
                : "Switch to light theme"
            }
            aria-label="Toggle theme"
          >
            {prefs.theme === "light" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            )}
          </button>
          {/* Mobile button — flips the iosLayout pref so the page renders
              the iOS shell. Mirrors the "Desktop" pill on the mobile
              header so the round-trip is symmetric. */}
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-2 text-xs font-semibold text-violet-700 hover:border-violet-500 hover:bg-violet-100"
            onClick={() => setPrefs({ iosLayout: true })}
            title="Switch to the iOS view"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="2" width="12" height="20" rx="2" />
              <path d="M11 18h2" />
            </svg>
            Mobile
          </button>
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
              <span className="hidden sm:inline">Sign out</span>
              <span className="sm:hidden" aria-label="Sign out">⏻</span>
            </button>
          )}
        </div>
      </header>

      {/* Header rows wrapper — tight 8px gap between row 1 (tabs +
          adders) and row 2 (mode + AI/Google), overriding the parent
          space-y-6/8 that's used for the bigger content blocks. */}
      <div className="flex flex-col gap-2">
      {/* Row 1 — Mode switch (Both / Projects / Personal) LEFT ·
          Task-adders RIGHT (Brain dump / Scan / Export PDF / +Task). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <ModeSwitch
            mode={prefs.mode}
            userType={prefs.userType}
            onChange={(mode) => setPrefs({ mode })}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            onClick={() => setShowBrainDump(true)}
            title="Paste a list and let Claude parse it into tasks"
          >
            ✨<span className="hidden sm:inline"> Brain dump</span>
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            onClick={() => setShowPlannerScan(true)}
            title="Scan a marked-up planner photo back into the app"
            disabled={tasks.length === 0}
          >
            📥<span className="hidden sm:inline"> Scan</span>
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            onClick={() => {
              void exportWeeklyPlanner(tasks, prefs, aiTierMap);
            }}
            title="Download a 7-day Top Three planner as PDF"
            disabled={tasks.length === 0}
          >
            📄<span className="hidden sm:inline"> Export PDF</span>
          </button>
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={startNew}
            title="Add a single task"
          >
            + <span className="hidden sm:inline">Task</span>
          </button>
        </div>
      </div>

      {/* Row 2 — Tabs (Today / Tasks / Insights / Goals) LEFT ·
          AI Smart organise + Google Sync RIGHT. Tab nav keeps the
          underline so the active tab is unambiguous. */}
      <nav className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-slate-200/70 pb-1">
        {TAB_DEFS.map((t) => {
          const active = view === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setView(t.key)}
              className={`relative px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "text-slate-900"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900"
                />
              )}
            </button>
          );
        })}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <SmartActionsBar
            tasks={tasks}
            goals={goals}
            onAiRerank={handleAiRefresh}
            onLinkTaskToGoal={(taskId, goalId) => {
              const t = tasks.find((x) => x.id === taskId);
              if (!t) return;
              const cur = t.goalIds ?? [];
              if (cur.includes(goalId)) return;
              updateTask(taskId, { goalIds: [...cur, goalId] });
            }}
            onAutoSync={handleAutoSync}
            onSkipEvent={(eventId) => {
              const cur = prefs.enrichmentSkippedEventIds ?? [];
              if (cur.includes(eventId)) return;
              setPrefs({ enrichmentSkippedEventIds: [...cur, eventId] });
            }}
            aiBusy={loading}
          />
        </div>
      </nav>
      </div>

      {calendarMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {calendarMsg}
        </div>
      )}

      {view === "today" && (
        <div className="space-y-8">
          <SlippedTasks
            tasks={findSlippedTasks(tasks)}
            onComplete={toggleComplete}
            onReschedule={openSchedulePicker}
            onDefer={(id, days) => {
              // Defer = MOVE the slipped target forward, not just hide it.
              // Computes (today + days) at the task's specificTime if set,
              // otherwise 9am. Clears any old snoozedUntil so the moved
              // instance shows up as the canonical version.
              //
              // Companies-House tasks (statutory deadlines) get special
              // treatment: the deadline (dueDate) STAYS PUT — that's
              // immovable from our side. Only the "do" date (scheduledFor)
              // moves. If no scheduledFor existed, we set one for the
              // first time so the user has a planning slot ahead of the
              // hard deadline.
              const task = tasks.find((t) => t.id === id);
              if (!task) return;
              const target = new Date();
              target.setDate(target.getDate() + days);
              const m = task.specificTime
                ? /^(\d{1,2}):(\d{2})$/.exec(task.specificTime)
                : null;
              if (m) {
                target.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
              } else {
                target.setHours(9, 0, 0, 0);
              }
              const patch: Partial<Task> = { snoozedUntil: undefined };
              if (task.companyHouseNumber) {
                // Statutory deadline — never touch dueDate.
                patch.scheduledFor = target.toISOString();
              } else if (task.scheduledFor) {
                patch.scheduledFor = target.toISOString();
              } else {
                patch.dueDate = target.toISOString();
              }
              updateTask(id, patch);
            }}
          />

          <Foundations
            tasks={foundations}
            onComplete={toggleComplete}
            onIncrement={incrementCounter}
            onEdit={startEdit}
            onDefer={(id) => {
              // Defer = hide from the rail until tomorrow same time.
              // Reuses snoozedUntil since the foundation filter already
              // honours it (and the task list / priority list ignore
              // foundations entirely, so no other view is affected).
              const until = new Date();
              until.setDate(until.getDate() + 1);
              updateTask(id, { snoozedUntil: until.toISOString() });
            }}
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
                  {aiStaleCount > 0 && (
                    <span
                      className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                      title={`${aiStaleCount} task${aiStaleCount === 1 ? "" : "s"} edited since the last AI rank — run Smart organise (top right) to refresh.`}
                    >
                      {aiStaleCount} stale
                    </span>
                  )}
                </span>
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
              onOpenGoal={(_goalId) => {
                // Switch to the Goals tab. The goal id is captured in the
                // closure for future "scroll-to" support if we add it.
                setView("goals");
              }}
            />
          </section>

          {/* Calendar sync now lives in the centralised header bar
              (SmartActionsBar → Google · Sync). The redundant inline
              button used to live here. */}

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
            onRepushToGoogle={async (taskId) => {
              const t = tasks.find((x) => x.id === taskId);
              if (!t) return;
              if (!googleStatus?.connected) {
                setCalendarMsg(
                  "Connect Google Calendar first (header → Connect Calendar).",
                );
                return;
              }
              const startIso = t.scheduledFor ?? t.dueDate;
              if (!startIso) {
                setCalendarMsg(
                  `"${t.title}" has no scheduled time — re-time it first.`,
                );
                return;
              }
              const start = new Date(startIso);
              const end = new Date(
                start.getTime() + (t.estimatedMinutes ?? 60) * 60_000,
              );
              try {
                // Clear the stale id first so we don't pretend to keep the
                // dead reference if the create call fails.
                updateTask(taskId, { calendarEventId: undefined });
                const { eventId } = await scheduleTask(t, start, end);
                updateTask(taskId, {
                  calendarEventId: eventId,
                  scheduledFor: undefined,
                });
                setCalendarMsg(
                  `"${t.title}" re-added to your personal calendar.`,
                );
              } catch (err) {
                setCalendarMsg(
                  `Re-create failed — ${err instanceof Error ? err.message : String(err)}`,
                );
              }
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
            onUpdatePrefs={setPrefs}
            onMessage={setCalendarMsg}
            onUnlinkTaskFromGoogle={(taskId) =>
              updateTask(taskId, { calendarEventId: undefined })
            }
            onPushSessionToGoogle={async (task, startIso) => {
              if (!googleStatus?.connected) return;
              const start = new Date(startIso);
              const end = new Date(
                start.getTime() + (task.estimatedMinutes ?? 60) * 60_000,
              );
              try {
                await scheduleTask(task, start, end);
              } catch {
                // Silent — user already has the local session; the message
                // banner reports the auto-schedule outcome separately.
              }
            }}
          />

          <TomorrowPreview
            prioritized={tomorrowPreview}
            onDoEarly={toggleComplete}
          />
        </div>
      )}

      {view === "tasks" && (
        <section className="space-y-4">
          {/* Sync from Google now centralised in the header bar
              (SmartActionsBar → Google · Sync). Removed the duplicate
              inline button that used to sit here. */}
          <h2 className="mb-3 text-lg font-semibold">All tasks</h2>
          <TaskList
            tasks={tasks}
            onToggle={toggleComplete}
            onRemove={removeTask}
            onEdit={startEdit}
            onUnsnooze={(id) => updateTask(id, { snoozedUntil: undefined })}
            onSchedule={openSchedulePicker}
            aiTierById={aiTierMap}
            mode={prefs.mode}
            userType={prefs.userType}
            ignoredEventIds={prefs.ignoredEventIds}
            onRefreshAi={handleAiRefresh}
            aiBusy={loading}
            aiRefreshTick={aiRefreshTick}
            onUpdateTask={updateTask}
          />
        </section>
      )}

      {view === "insights" && (
        <div className="space-y-8">
          <Achievements tasks={tasks} goals={goals} />
          <PriorityMatrix tasks={tasks} prefs={prefs} onEdit={startEdit} />
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
        <>
          <SuggestedGoalLinks
            tasks={tasks}
            goals={goals}
            dismissedTaskIds={prefs.dismissedGoalSuggestions ?? []}
            onLink={(taskId, goalId) => {
              const t = tasks.find((x) => x.id === taskId);
              if (!t) return;
              const cur = t.goalIds ?? [];
              if (cur.includes(goalId)) return;
              updateTask(taskId, { goalIds: [...cur, goalId] });
            }}
            onDismiss={(taskId) => {
              const cur = prefs.dismissedGoalSuggestions ?? [];
              if (cur.includes(taskId)) return;
              setPrefs({ dismissedGoalSuggestions: [...cur, taskId] });
            }}
          />
          <UnmappedTasks
            tasks={tasks}
            goals={goals}
            dismissedTaskIds={prefs.dismissedGoalSuggestions ?? []}
            onLink={(taskId, goalId) => {
              const t = tasks.find((x) => x.id === taskId);
              if (!t) return;
              const cur = t.goalIds ?? [];
              if (cur.includes(goalId)) return;
              updateTask(taskId, { goalIds: [...cur, goalId] });
            }}
            onDismiss={(taskId) => {
              const cur = prefs.dismissedGoalSuggestions ?? [];
              if (cur.includes(taskId)) return;
              setPrefs({ dismissedGoalSuggestions: [...cur, taskId] });
            }}
          />
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
        </>
      )}

      <footer className="pt-4 text-center text-xs text-slate-400">
        Local MVP · Calendar via Google · OCR via Tesseract · PDF planner
        <br />
        <a
          href="/privacy.html"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          Privacy
        </a>
        {" · "}
        <a
          href="/terms.html"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          Terms
        </a>
      </footer>

      {taskBeingScheduled && (
        <SchedulePicker
          task={taskBeingScheduled}
          calendarConnected={googleStatus?.connected ?? false}
          onConfirm={confirmSchedule}
          onCancel={() => setPickerForTaskId(null)}
          onEdit={(id) => {
            setPickerForTaskId(null);
            startEdit(id);
          }}
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
              // Imported task whose due date changed → also patch the
              // Google event so the calendar moves with the task.
              if (
                editingTask.calendarEventId &&
                input.dueDate &&
                input.dueDate !== editingTask.dueDate
              ) {
                const startMs = new Date(input.dueDate).getTime();
                const dur = (input.estimatedMinutes ?? 30) * 60 * 1000;
                const startIso = new Date(startMs).toISOString();
                const endIso = new Date(startMs + dur).toISOString();
                void patchEventTime(
                  editingTask.calendarEventId,
                  startIso,
                  endIso,
                  editingTask.calendarId,
                ).catch((err) => {
                  setCalendarMsg(
                    `Synced locally but Google update failed — ${
                      err instanceof Error ? err.message : "unknown"
                    }`,
                  );
                });
              }
            } else {
              addTaskAndEnrich(input);
            }
          }}
          onClose={closeTaskForm}
          onSwitchToBrainDump={() => setShowBrainDump(true)}
        />
      )}

      {showBrainDump && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm px-2 py-4 sm:px-4 sm:py-8"
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
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm px-2 py-4 sm:px-4 sm:py-8"
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
              onClose={() => {
                // Commit the scan-session buffer as the new "last scan
                // undo" entry so the user can revert from Settings.
                commitScanSession();
                setShowPlannerScan(false);
              }}
            />
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          prefs={prefs}
          onChange={setPrefs}
          onClose={() => setShowSettings(false)}
          onExport={() => {
            downloadBackup(tasks, goals, prefs);
            logMetricEvent("backup_exported", {
              taskCount: tasks.length,
              goalCount: goals.length,
            });
          }}
          onImport={async (file) => {
            const bundle = await readBackupFile(file);
            replaceAllTasks(bundle.tasks);
            replaceAllGoals(bundle.goals);
            replacePrefs(bundle.prefs);
            logMetricEvent("backup_imported", {
              taskCount: bundle.tasks.length,
              goalCount: bundle.goals.length,
              version: bundle.version,
            });
            // v2 backups carry the AI rank cache. Restoring it preserves the
            // user's last AI-ranked Top Three across the cutover.
            if (bundle.aiCache) {
              setAiCache(
                new Map(bundle.aiCache.ranks as Array<[string, CachedRank]>),
              );
              if (bundle.aiCache.ranks.length > 0) setSource("claude");
            }
          }}
          lastScanUndo={
            lastScanUndo
              ? {
                  ts: lastScanUndo.ts,
                  count: lastScanUndo.items.length,
                  onUndo: undoLastScan,
                }
              : undefined
          }
          calendar={{
            // Default to "configured + not connected" until the status
            // fetch comes back, so the Connect Calendar button is always
            // visible — never gets hidden by a slow or failed status check.
            configured: googleStatus?.configured ?? true,
            connected: googleStatus?.connected ?? false,
            email: googleStatus?.email ?? null,
            // Re-throw so SettingsPanel can render the error inline (the
            // global `calendarMsg` banner sits behind the modal).
            onConnect: async () => {
              try {
                await startGoogleConnect();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setCalendarMsg(`Connect failed — ${msg}`);
                throw err;
              }
            },
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
