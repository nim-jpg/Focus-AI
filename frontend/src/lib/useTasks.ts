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

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks());
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
          return {
            ...t,
            lastCompletedAt: doneToday ? undefined : now,
            status: "pending",
            updatedAt: now,
          };
        }

        return {
          ...t,
          status: t.status === "completed" ? "pending" : "completed",
          lastCompletedAt: t.status === "completed" ? t.lastCompletedAt : now,
          updatedAt: now,
        };
      }),
    );
  }, []);

  const setPrefs = useCallback((patch: Partial<UserPrefs>) => {
    setPrefsState((prev) => ({ ...prev, ...patch }));
  }, []);

  return {
    tasks,
    prefs,
    addTask,
    updateTask,
    removeTask,
    toggleComplete,
    setPrefs,
  };
}
