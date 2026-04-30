import type { Task } from "@/types/task";
import { apiFetch } from "./api";

export interface DateSuggestion {
  taskId: string;
  dueDate: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export class SuggestUnavailableError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "SuggestUnavailableError";
  }
}

export async function suggestDueDates(tasks: Task[]): Promise<DateSuggestion[]> {
  const candidates = tasks
    .filter((t) => !t.dueDate && t.status !== "completed")
    .map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      theme: t.theme,
    }));

  if (candidates.length === 0) return [];

  let res: Response;
  try {
    res = await apiFetch("/api/suggest-due-dates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: candidates }),
    });
  } catch (err) {
    throw new SuggestUnavailableError(
      err instanceof Error ? err.message : "network_error",
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new SuggestUnavailableError(
      body.message ?? body.error ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  const data = (await res.json()) as { suggestions: DateSuggestion[] };
  return data.suggestions ?? [];
}
