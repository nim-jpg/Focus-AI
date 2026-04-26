import { useCallback, useEffect, useState } from "react";
import { generateId, loadGoals, saveGoals } from "./storage";
import type { Goal } from "@/types/task";

export type NewGoalInput = Omit<Goal, "id" | "createdAt" | "updatedAt" | "source"> &
  Partial<Pick<Goal, "source">>;

export function useGoals() {
  const [goals, setGoals] = useState<Goal[]>(() => loadGoals());

  useEffect(() => {
    saveGoals(goals);
  }, [goals]);

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

  return { goals, addGoal, updateGoal, removeGoal };
}
