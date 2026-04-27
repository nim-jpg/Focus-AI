import { useCallback, useEffect, useState } from "react";
import {
  generateId,
  loadPrefs,
  loadTasks,
  savePrefs,
  saveTasks,
} from "./storage";
import { wasCompletedToday } from "./recurrence";
import type { Task, UserPrefs } from "@/types/task";

export type NewTaskInput = Omit<Task, "id" | "createdAt" | "updatedAt" | "status"> &
  Partial<Pick<Task, "status">>;

function startOfWeek(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
  return c;
}

/**
 * One-time cull: drop sessionTimes that aren't in the current or upcoming week.
 * Old session entries pile up otherwise and confuse the auto-scheduler.
 */
function cullStaleSessionTimes(tasks: Task[]): Task[] {
  const wkStart = startOfWeek(new Date()).getTime();
  const wkEnd = wkStart + 14 * 24 * 60 * 60 * 1000; // include next week
  let changed = false;
  const next = tasks.map((t) => {
    if (!t.sessionTimes || t.sessionTimes.length === 0) return t;
    const filtered = t.sessionTimes.filter((iso) => {
      const ts = new Date(iso).getTime();
      return ts >= wkStart && ts < wkEnd;
    });
    if (filtered.length !== t.sessionTimes.length) {
      changed = true;
      return { ...t, sessionTimes: filtered };
    }
    return t;
  });
  return changed ? next : tasks;
}

/**
 * For tasks that pre-date the completionLog field but had a lastCompletedAt
 * stamp, seed the log with that one date so streaks aren't 0 on first load.
 */
function seedCompletionLog(tasks: Task[]): Task[] {
  let changed = false;
  const next = tasks.map((t) => {
    if (t.recurrence === "none") return t;
    if (t.completionLog && t.completionLog.length > 0) return t;
    if (!t.lastCompletedAt) return t;
    const d = new Date(t.lastCompletedAt);
    if (Number.isNaN(d.getTime())) return t;
    const seed = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    changed = true;
    return { ...t, completionLog: [seed] };
  });
  return changed ? next : tasks;
}

function migrate(tasks: Task[]): Task[] {
  return seedCompletionLog(cullStaleSessionTimes(tasks));
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => migrate(loadTasks()));
  const [prefs, setPrefsState] = useState<UserPrefs>(() => loadPrefs());

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const addTask = useCallback((input: NewTaskInput) => {
    const now = new Date().toISOString();
    const task: Task = {
      ...input,
      id: generateId(),
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    };
    setTasks((prev) => [task, ...prev]);
    return task;
  }, []);

  const updateTask = useCallback(
    (id: string, patch: Partial<Task>) => {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t,
        ),
      );
    },
    [],
  );

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /**
   * Mark a recurring task as completed on a specific calendar date.
   * Used by scan-back when the user ticks a daily-habit day box — we
   * want the streak/log to attribute the tick to that day, not "today
   * (Wed) when the scan happened". For non-recurring tasks this falls
   * back to the standard toggleComplete semantics.
   */
  const markCompletedOn = useCallback((id: string, dateIso: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const targetDate = new Date(dateIso);
        if (Number.isNaN(targetDate.getTime())) return t;
        const nowIso = new Date().toISOString();
        if (t.recurrence !== "none") {
          const dayKey = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}-${String(targetDate.getDate()).padStart(2, "0")}`;
          const log = new Set(t.completionLog ?? []);
          log.add(dayKey);
          return {
            ...t,
            lastCompletedAt: targetDate.toISOString(),
            completionLog: Array.from(log).sort(),
            status: "pending",
            updatedAt: nowIso,
          };
        }
        // Non-recurring: just complete it.
        return {
          ...t,
          status: "completed",
          lastCompletedAt: targetDate.toISOString(),
          avoidanceWeeks: 0,
          lastSurfacedAt: undefined,
          updatedAt: nowIso,
        };
      }),
    );
  }, []);

  const toggleComplete = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const now = new Date().toISOString();

        // Recurring tasks don't get a permanent "completed" status — they
        // re-arm at the next interval. Toggle today's stamp so users can
        // un-tick a basic they hit by accident.
        if (t.recurrence !== "none") {
          const doneToday = wasCompletedToday(t);
          const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
          const log = new Set(t.completionLog ?? []);
          if (doneToday) log.delete(todayKey);
          else log.add(todayKey);
          return {
            ...t,
            lastCompletedAt: doneToday ? undefined : now,
            completionLog: Array.from(log).sort(),
            status: "pending",
            updatedAt: now,
          };
        }

        const completing = t.status !== "completed";
        return {
          ...t,
          status: completing ? "completed" : "pending",
          lastCompletedAt: completing ? now : t.lastCompletedAt,
          // Completing breaks the avoidance streak; clear surfaced stamp + counter.
          avoidanceWeeks: completing ? 0 : t.avoidanceWeeks,
          lastSurfacedAt: completing ? undefined : t.lastSurfacedAt,
          updatedAt: now,
        };
      }),
    );
  }, []);

  /**
   * Stamp lastSurfacedAt for every id in `ids`. If a task was previously surfaced
   * 7+ days ago without being completed, bump avoidanceWeeks — that's the signal
   * the scoring engine uses to escalate long-avoided work.
   */
  const markSurfaced = useCallback((ids: string[], now: Date = new Date()) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const nowIso = now.toISOString();
    const todayMs = now.getTime();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    setTasks((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (!idSet.has(t.id)) return t;
        if (t.recurrence !== "none") return t; // recurring tasks reset; avoidance n/a
        if (t.status === "completed") return t;

        const last = t.lastSurfacedAt ? new Date(t.lastSurfacedAt).getTime() : null;
        const sameDay = last
          ? new Date(last).toDateString() === now.toDateString()
          : false;
        if (sameDay) return t; // already stamped today

        const weeksToAdd =
          last !== null ? Math.floor((todayMs - last) / SEVEN_DAYS_MS) : 0;

        changed = true;
        return {
          ...t,
          lastSurfacedAt: nowIso,
          avoidanceWeeks: (t.avoidanceWeeks ?? 0) + weeksToAdd,
        };
      });
      return changed ? next : prev;
    });
  }, []);

  const incrementCounter = useCallback((id: string, delta: number) => {
    const todayStr = new Date().toISOString().slice(0, 10);
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id || !t.counter) return t;
        const baseCount = t.counter.date === todayStr ? t.counter.count : 0;
        const next = Math.max(0, baseCount + delta);
        const now = new Date().toISOString();
        const reachedTarget = next >= t.counter.target;
        const log = new Set(t.completionLog ?? []);
        if (reachedTarget) log.add(todayStr);
        else log.delete(todayStr);
        return {
          ...t,
          counter: { ...t.counter, date: todayStr, count: next },
          lastCompletedAt: reachedTarget ? now : t.lastCompletedAt,
          completionLog: Array.from(log).sort(),
          updatedAt: now,
        };
      }),
    );
  }, []);

  const setPrefs = useCallback((patch: Partial<UserPrefs>) => {
    setPrefsState((prev) => ({ ...prev, ...patch }));
  }, []);

  const replaceAllTasks = useCallback((next: Task[]) => setTasks(next), []);
  const replacePrefs = useCallback((next: UserPrefs) => setPrefsState(next), []);

  return {
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
  };
}
