import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateId,
  loadGoals,
  saveGoals,
  syncGoalsFromRemote,
} from "./storage";
import { isAuthEnabled } from "./supabaseClient";
import { logEvent } from "./metrics";
import type { Goal } from "@/types/task";

export type NewGoalInput = Omit<Goal, "id" | "createdAt" | "updatedAt" | "source"> &
  Partial<Pick<Goal, "source">>;

export function useGoals() {
  const [goals, setGoals] = useState<Goal[]>(() => loadGoals());
  // Suppress saves until the initial pull from backend completes — otherwise
  // a fresh device's empty cache would push [] and wipe the user's goals.
  const synced = useRef(!isAuthEnabled());

  useEffect(() => {
    if (!synced.current) return;
    saveGoals(goals);
  }, [goals]);

  // Cache-first sync: localStorage gives instant first paint; if Supabase
  // auth is on, the canonical copy from the backend replaces it.
  useEffect(() => {
    if (!isAuthEnabled()) return;
    let cancelled = false;
    void syncGoalsFromRemote().then((remote) => {
      if (cancelled) return;
      if (remote) setGoals(remote);
      synced.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const addGoal = useCallback((input: NewGoalInput) => {
    const now = new Date().toISOString();
    const goal: Goal = {
      ...input,
      id: generateId(),
      source: input.source ?? "manual",
      createdAt: now,
      updatedAt: now,
    };
    setGoals((prev) => [goal, ...prev]);
    logEvent("goal_created", {
      horizon: goal.horizon,
      source: goal.source,
    });
    return goal;
  }, []);

  const updateGoal = useCallback((id: string, patch: Partial<Goal>) => {
    setGoals((prev) =>
      prev.map((g) =>
        g.id === id ? { ...g, ...patch, updatedAt: new Date().toISOString() } : g,
      ),
    );
  }, []);

  const removeGoal = useCallback((id: string) => {
    setGoals((prev) => {
      const target = prev.find((g) => g.id === id);
      if (target) logEvent("goal_deleted", { horizon: target.horizon });
      return prev.filter((g) => g.id !== id);
    });
  }, []);

  const replaceAllGoals = useCallback((next: Goal[]) => setGoals(next), []);

  return { goals, addGoal, updateGoal, removeGoal, replaceAllGoals };
}
