import type { Task } from "@/types/task";
import { apiFetch } from "./api";

export type ScanAction =
  | "complete"
  | "defer"
  | "block"
  | "timeSpent"
  | "rename"
  /** Tick on a daily-habit row for one day. value = { day, count? }. */
  | "habitTick"
  /** Free-text handwritten note from the notes box. value = transcribed text. */
  | "newNote"
  /** Handwritten task to add. value = { title, theme?, dueDate?, urgency? }. */
  | "createTask"
  /** Handwritten goal to add. value = { title, horizon?, theme? }. */
  | "createGoal";

export interface ScanUpdate {
  /** Set when the row had a printed shortId stamp (key + stretch tasks). */
  shortId?: string;
  /** Set when the row was matched by title (backlog + daily habits). */
  taskTitle?: string;
  action: ScanAction;
  value?:
    | string
    | number
    | { day?: string; count?: number }
    | {
        title?: string;
        theme?: string;
        dueDate?: string;
        urgency?: string;
        horizon?: string;
      };
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

/** Find a task by title — exact match first, then case-insensitive
 *  prefix match (Claude may transcribe with slight variations). */
export function findTaskByTitle(tasks: Task[], title: string): Task | null {
  const t = title.trim();
  if (!t) return null;
  const exact = tasks.find((x) => x.title === t);
  if (exact) return exact;
  const lower = t.toLowerCase();
  const prefix = tasks.find((x) => x.title.toLowerCase().startsWith(lower));
  if (prefix) return prefix;
  const contains = tasks.find((x) => x.title.toLowerCase().includes(lower));
  return contains ?? null;
}

export async function scanPlanner(
  input: { text?: string; image?: { base64: string; mediaType: string } },
  tasks: Task[],
): Promise<ScanUpdate[]> {
  const shortIds = tasks.map((t) => shortIdFor(t.id));
  const taskTitles = tasks
    .filter((t) => t.status !== "completed")
    .map((t) => t.title);
  const res = await apiFetch("/api/scan-planner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: input.text,
      imageBase64: input.image?.base64,
      mediaType: input.image?.mediaType,
      shortIds,
      taskTitles,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ScanError(body.message ?? `HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as { updates: ScanUpdate[] };
  return data.updates ?? [];
}

/** Read a File as a base64 string (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}
