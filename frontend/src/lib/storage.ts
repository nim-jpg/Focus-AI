import { DEFAULT_PREFS, type Goal, type Task, type UserPrefs } from "@/types/task";
import { apiFetch } from "./api";
import { getSupabase, isAuthEnabled } from "./supabaseClient";

const TASKS_KEY = "focus3:tasks:v1";
const PREFS_KEY = "focus3:prefs:v1";
const GOALS_KEY = "focus3:goals:v1";

/**
 * Storage strategy:
 *  - Single-user / no Supabase configured → keys above; data lives in localStorage only.
 *  - Multi-user / Supabase configured AND signed in → keys gain a ":<userId>" suffix
 *    so each tester's cache stays separate inside the same browser; the canonical
 *    source-of-truth is the backend (supabase Postgres via /api/store), and
 *    localStorage acts as a cache for fast first-paint and offline tolerance.
 *
 * Reads stay synchronous (return whatever's in the cache). Async sync helpers
 * pull the latest from the backend and write into the cache, and push helpers
 * fire-and-forget any local change up to the backend.
 */

async function currentUserId(): Promise<string | null> {
  if (!isAuthEnabled()) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

function syncUserIdSnapshot(): string | null {
  // Pull the userId from a Supabase storage key Supabase writes itself —
  // synchronous because cached read paths can't await. May be null briefly
  // on a cold reload before the SDK rehydrates; that's fine, we'll fall
  // back to the unscoped key and the async sync will fix it.
  if (!isAuthEnabled()) return null;
  try {
    const supabase = getSupabase();
    if (!supabase) return null;
    // supabase-js stores the session under sb-<project-ref>-auth-token by default.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("sb-") || !k.endsWith("-auth-token")) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        user?: { id?: string };
        currentSession?: { user?: { id?: string } };
      };
      const id = parsed.user?.id ?? parsed.currentSession?.user?.id;
      if (id) return id;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function tasksKey(uid: string | null): string {
  return uid ? `${TASKS_KEY}:${uid}` : TASKS_KEY;
}
function prefsKey(uid: string | null): string {
  return uid ? `${PREFS_KEY}:${uid}` : PREFS_KEY;
}
function goalsKey(uid: string | null): string {
  return uid ? `${GOALS_KEY}:${uid}` : GOALS_KEY;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Tasks ────────────────────────────────────────────────────────────────

export function loadTasks(): Task[] {
  const uid = syncUserIdSnapshot();
  return safeParse<Task[]>(localStorage.getItem(tasksKey(uid)), []);
}

export function saveTasks(tasks: Task[]): void {
  const uid = syncUserIdSnapshot();
  localStorage.setItem(tasksKey(uid), JSON.stringify(tasks));
  void pushTasksRemote(tasks);
}

async function pushTasksRemote(tasks: Task[]): Promise<void> {
  if (!isAuthEnabled()) return;
  try {
    await apiFetch("/api/store/tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    });
  } catch {
    /* silent — local cache still holds the truth until the next sync */
  }
}

export async function syncTasksFromRemote(): Promise<Task[] | null> {
  if (!isAuthEnabled()) return null;
  const uid = await currentUserId();
  if (!uid) return null;
  try {
    const res = await apiFetch("/api/store/tasks");
    if (!res.ok) return null;
    const data = (await res.json()) as { tasks: Task[] };
    localStorage.setItem(tasksKey(uid), JSON.stringify(data.tasks));
    return data.tasks;
  } catch {
    return null;
  }
}

// ─── Prefs ────────────────────────────────────────────────────────────────

export function loadPrefs(): UserPrefs {
  const uid = syncUserIdSnapshot();
  const stored = safeParse<Partial<UserPrefs>>(
    localStorage.getItem(prefsKey(uid)),
    {},
  );
  return { ...DEFAULT_PREFS, ...stored };
}

export function savePrefs(prefs: UserPrefs): void {
  const uid = syncUserIdSnapshot();
  localStorage.setItem(prefsKey(uid), JSON.stringify(prefs));
  void pushPrefsRemote(prefs);
}

async function pushPrefsRemote(prefs: UserPrefs): Promise<void> {
  if (!isAuthEnabled()) return;
  try {
    await apiFetch("/api/store/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs }),
    });
  } catch {
    /* ignore */
  }
}

export async function syncPrefsFromRemote(): Promise<UserPrefs | null> {
  if (!isAuthEnabled()) return null;
  const uid = await currentUserId();
  if (!uid) return null;
  try {
    const res = await apiFetch("/api/store/prefs");
    if (!res.ok) return null;
    const data = (await res.json()) as { prefs: Partial<UserPrefs> | null };
    if (!data.prefs) return null;
    const merged = { ...DEFAULT_PREFS, ...data.prefs };
    localStorage.setItem(prefsKey(uid), JSON.stringify(merged));
    return merged;
  } catch {
    return null;
  }
}

// ─── Goals ────────────────────────────────────────────────────────────────

export function loadGoals(): Goal[] {
  const uid = syncUserIdSnapshot();
  return safeParse<Goal[]>(localStorage.getItem(goalsKey(uid)), []);
}

export function saveGoals(goals: Goal[]): void {
  const uid = syncUserIdSnapshot();
  localStorage.setItem(goalsKey(uid), JSON.stringify(goals));
  void pushGoalsRemote(goals);
}

async function pushGoalsRemote(goals: Goal[]): Promise<void> {
  if (!isAuthEnabled()) return;
  try {
    await apiFetch("/api/store/goals", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goals }),
    });
  } catch {
    /* ignore */
  }
}

export async function syncGoalsFromRemote(): Promise<Goal[] | null> {
  if (!isAuthEnabled()) return null;
  const uid = await currentUserId();
  if (!uid) return null;
  try {
    const res = await apiFetch("/api/store/goals");
    if (!res.ok) return null;
    const data = (await res.json()) as { goals: Goal[] };
    localStorage.setItem(goalsKey(uid), JSON.stringify(data.goals));
    return data.goals;
  } catch {
    return null;
  }
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
