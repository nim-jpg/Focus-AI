import type { PrioritizedTask, Task, UserPrefs } from "@/types/task";
import { isFoundation, isDueNow } from "./recurrence";
import { apiFetch } from "./api";

interface AiResponse {
  topThree: Array<{ taskId: string; tier: 1 | 2 | 3 | 4; reasoning: string }>;
  source: "claude";
}

export class AiUnavailableError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/**
 * POST tasks to the backend for Claude-powered prioritization.
 * Throws AiUnavailableError if the backend is missing/unreachable/unconfigured —
 * callers should fall back to the local heuristic.
 */
export async function aiPrioritize(
  tasks: Task[],
  prefs: UserPrefs,
): Promise<PrioritizedTask[]> {
  const now = new Date();
  const candidates = tasks.filter((t) => {
    if (t.status === "completed") return false;
    if (isFoundation(t)) return false;
    if (t.recurrence !== "none" && !isDueNow(t, now)) return false;
    if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > now.getTime()) {
      return false;
    }
    return true;
  });

  let res: Response;
  try {
    res = await apiFetch("/api/prioritize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: candidates, prefs }),
    });
  } catch (err) {
    throw new AiUnavailableError(
      err instanceof Error ? err.message : "network_error",
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new AiUnavailableError(
      body.message ?? body.error ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  const data = (await res.json()) as AiResponse;
  const byId = new Map(candidates.map((t) => [t.id, t]));

  return data.topThree
    .map(({ taskId, tier, reasoning }) => {
      const task = byId.get(taskId);
      if (!task) return null;
      return { task, tier, reasoning, score: 0 } satisfies PrioritizedTask;
    })
    .filter((p): p is PrioritizedTask => p !== null);
}
