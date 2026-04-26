import type { Task } from "@/types/task";
import { apiFetch } from "./api";

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

export async function scanPlanner(
  input: { text?: string; image?: { base64: string; mediaType: string } },
  tasks: Task[],
): Promise<ScanUpdate[]> {
  const shortIds = tasks.map((t) => shortIdFor(t.id));
  const res = await apiFetch("/api/scan-planner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: input.text,
      imageBase64: input.image?.base64,
      mediaType: input.image?.mediaType,
      shortIds,
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
