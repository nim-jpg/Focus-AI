import { DEFAULT_PREFS, type Goal, type Task, type UserPrefs } from "@/types/task";

const TASKS_KEY = "focus3:tasks:v1";
const PREFS_KEY = "focus3:prefs:v1";
const GOALS_KEY = "focus3:goals:v1";

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadTasks(): Task[] {
  return safeParse<Task[]>(localStorage.getItem(TASKS_KEY), []);
}

export function saveTasks(tasks: Task[]): void {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

export function loadPrefs(): UserPrefs {
  return safeParse<UserPrefs>(localStorage.getItem(PREFS_KEY), DEFAULT_PREFS);
}

export function savePrefs(prefs: UserPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export function loadGoals(): Goal[] {
  return safeParse<Goal[]>(localStorage.getItem(GOALS_KEY), []);
}

export function saveGoals(goals: Goal[]): void {
  localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
