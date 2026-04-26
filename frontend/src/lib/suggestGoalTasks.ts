import type { Goal, Task } from "@/types/task";
import { apiFetch } from "./api";

export interface GoalTaskMatch {
  taskId: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export class SuggestGoalTasksError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "SuggestGoalTasksError";
  }
}

export async function suggestGoalTasks(
  goal: Goal,
  candidates: Task[],
): Promise<GoalTaskMatch[]> {
  const slim = candidates
    .filter((t) => t.status !== "completed")
    .map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      theme: t.theme,
    }));

  if (slim.length === 0) return [];

  let res: Response;
  try {
    res = await apiFetch("/api/suggest-goal-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: {
          title: goal.title,
          horizon: goal.horizon,
          theme: goal.theme,
          notes: goal.notes,
        },
        tasks: slim,
      }),
    });
  } catch (err) {
    throw new SuggestGoalTasksError(
      err instanceof Error ? err.message : "network_error",
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new SuggestGoalTasksError(
      body.message ?? body.error ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  const data = (await res.json()) as { matches: GoalTaskMatch[] };
  return data.matches ?? [];
}
