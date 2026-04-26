import type { Task } from "@/types/task";

export type ScanAction = "complete" | "defer" | "block" | "timeSpent" | "rename";

export interface ScanUpdate {
  shortId: string;
  action: ScanAction;
  value?: string | number;
  evidence?: string;
}

export class ScanError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ScanError";
  }
}

export function shortIdFor(taskId: string): string {
  return `#${taskId.replace(/[^a-z0-9]/gi, "").slice(-6)}`;
}

export function findTaskByShortId(tasks: Task[], shortId: string): Task | null {
  const target = shortId.replace(/^#/, "").toLowerCase();
  return tasks.find((t) => shortIdFor(t.id).slice(1).toLowerCase() === target) ?? null;
}

export async function scanPlanner(text: string, tasks: Task[]): Promise<ScanUpdate[]> {
  const shortIds = tasks.map((t) => shortIdFor(t.id));
  const res = await fetch("/api/scan-planner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, shortIds }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ScanError(body.message ?? `HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as { updates: ScanUpdate[] };
  return data.updates ?? [];
}
