import { useCallback, useEffect, useState } from "react";
import {
  generateId,
  loadGoals,
  saveGoals,
  syncGoalsFromRemote,
} from "./storage";
import type { Goal } from "@/types/task";

export type NewGoalInput = Omit<Goal, "id" | "createdAt" | "updatedAt" | "source"> &
  Partial<Pick<Goal, "source">>;

export function useGoals() {
  const [goals, setGoals] = useState<Goal[]>(() => loadGoals());

  useEffect(() => {
    saveGoals(goals);
  }, [goals]);

  // Cache-first sync: localStorage gives instant first paint; if Supabase
  // auth is on, the canonical copy from the backend replaces it.
  useEffect(() => {
    let cancelled = false;
    void syncGoalsFromRemote().then((remote) => {
      if (!cancelled && remote) setGoals(remote);
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
    setGoals((prev) => prev.filter((g) => g.id !== id));
  }, []);

  const replaceAllGoals = useCallback((next: Goal[]) => setGoals(next), []);

  return { goals, addGoal, updateGoal, removeGoal, replaceAllGoals };
}
