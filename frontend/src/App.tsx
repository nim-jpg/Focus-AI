import { useEffect, useMemo, useRef, useState } from "react";
import { TaskFormModal } from "@/components/TaskFormModal";
import { TaskList } from "@/components/TaskList";
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
  scheduleTask,
  startGoogleConnect,
  type GoogleStatus,
} from "@/lib/googleCalendar";
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
      // If the task is already linked to a Google event, delete it first so
      // re-scheduling produces ONE event at the new time, not a leftover at
      // the old time plus a fresh one. The user has been hitting this — every
      // re-schedule was generating a duplicate.
      if (task.calendarEventId) {
        try {
          const { deleteEvent } = await import("@/lib/googleCalendar");
          await deleteEvent(task.calendarEventId);
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

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:space-y-8 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* Brand mark — same Focus3 dot trio from the favicon, sized for
              the header. Adds visual identity without an image asset. */}
          <div
            aria-hidden
            className="hidden h-9 w-9 flex-none items-center justify-center rounded-xl bg-slate-900 shadow-md shadow-slate-900/20 sm:flex"
          >
            <div className="flex gap-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            </div>
          </div>
          <div className="min-w-0">
            <h1 className="bg-gradient-to-br from-slate-900 to-slate-700 bg-clip-text text-xl font-bold tracking-tight text-transparent sm:text-2xl">
              Focus3
            </h1>
            <p className="hidden text-sm text-slate-500 sm:block">
              Three things, every day. Your non-negotiables, surfaced.
            </p>
          </div>
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
              Calendar
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
              Calendar
              <span aria-hidden>⛓️‍💥</span>
            </button>
          )}
          <ModeSwitch
            mode={prefs.mode}
            userType={prefs.userType}
            onChange={(mode) => setPrefs({ mode })}
          />
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

      <nav className="flex flex-wrap items-center gap-1 border-b border-slate-200/70">
        {TAB_DEFS.map((t) => {
          const active = view === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setView(t.key)}
              className={`relative px-3 py-2.5 text-sm font-medium transition-colors ${
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
        <div className="ml-auto flex flex-wrap items-center gap-1.5 pr-1">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => {
              void exportWeeklyPlanner(tasks, prefs, aiTierMap);
            }}
            title="Download a 7-day Top Three planner as PDF"
            disabled={tasks.length === 0}
          >
            <span className="hidden sm:inline">Export </span>PDF
          </button>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => setShowPlannerScan(true)}
            title="Scan a marked-up planner photo back into the app"
            disabled={tasks.length === 0}
          >
            📥<span className="hidden sm:inline"> Scan</span>
          </button>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => setShowBrainDump(true)}
            title="Paste a list and let Claude parse it into tasks"
          >
            ✨<span className="hidden sm:inline"> Brain dump</span>
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={startNew}
            title="Add a single task"
          >
            + <span className="hidden sm:inline">Task</span>
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
          <SlippedTasks
            tasks={findSlippedTasks(tasks)}
            onComplete={toggleComplete}
            onReschedule={openSchedulePicker}
            onSnooze={(id, until) => updateTask(id, { snoozedUntil: until })}
          />

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
                  className={`btn-secondary ${aiStaleCount > 0 ? "ring-2 ring-amber-400" : ""}`}
                  onClick={handleAiRefresh}
                  disabled={loading || tasks.length === 0}
                  title={
                    aiStaleCount > 0
                      ? `${aiStaleCount} task${aiStaleCount === 1 ? "" : "s"} edited since the last AI rank — click to re-rank just those`
                      : aiCache.size > 0
                        ? "Ask Claude to rank any new or changed tasks (existing ranks are preserved)"
                        : "Ask Claude to rank your tasks"
                  }
                >
                  {loading
                    ? "Asking Claude…"
                    : aiStaleCount > 0
                      ? `Refresh AI · ${aiStaleCount} stale`
                      : source === "claude" && aiCache.size > 0
                        ? "Refresh AI (incremental)"
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
              onOpenGoal={(_goalId) => {
                // Switch to the Goals tab. The goal id is captured in the
                // closure for future "scroll-to" support if we add it.
                setView("goals");
              }}
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
        <section>
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
            onRefreshAi={handleAiRefresh}
            aiBusy={loading}
            aiRefreshTick={aiRefreshTick}
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
            } else {
              addTaskAndEnrich(input);
            }
          }}
          onClose={closeTaskForm}
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
          tasks={tasks}
          onImportEvent={(input) => addTask(input)}
          onExport={() => downloadBackup(tasks, goals, prefs)}
          onImport={async (file) => {
            const bundle = await readBackupFile(file);
            replaceAllTasks(bundle.tasks);
            replaceAllGoals(bundle.goals);
            replacePrefs(bundle.prefs);
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
