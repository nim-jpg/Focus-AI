import type { Task } from "@/types/task";

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email?: string | null;
}

export class CalendarError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "CalendarError";
  }
}

export async function fetchGoogleStatus(): Promise<GoogleStatus> {
  const res = await fetch("/api/google/status");
  if (!res.ok) throw new CalendarError(`HTTP ${res.status}`, res.status);
  return (await res.json()) as GoogleStatus;
}

export async function startGoogleConnect(): Promise<void> {
  const res = await fetch("/api/google/auth-url");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new CalendarError(
      (body as { message?: string }).message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  const { url } = (await res.json()) as { url: string };
  window.location.href = url;
}

export async function disconnectGoogle(): Promise<void> {
  await fetch("/api/google/disconnect", { method: "DELETE" });
}

/**
 * Schedule a task as a calendar event today. We block its estimated minutes
 * starting in 30 minutes from now (a sensible "next available slot" default).
 */
export async function scheduleTask(task: Task): Promise<{ eventId: string; htmlLink?: string }> {
  const start = new Date(Date.now() + 30 * 60 * 1000);
  const end = new Date(start.getTime() + (task.estimatedMinutes ?? 30) * 60 * 1000);
  const res = await fetch("/api/google/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: task.title,
      description: task.description ?? "",
      start: start.toISOString(),
      end: end.toISOString(),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new CalendarError(
      (body as { message?: string }).message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  return (await res.json()) as { eventId: string; htmlLink?: string };
}
