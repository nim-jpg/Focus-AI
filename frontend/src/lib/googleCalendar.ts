import type { Task } from "@/types/task";
import { apiFetch } from "./api";

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
  const res = await apiFetch("/api/google/status");
  if (!res.ok) throw new CalendarError(`HTTP ${res.status}`, res.status);
  return (await res.json()) as GoogleStatus;
}

export async function startGoogleConnect(): Promise<void> {
  console.log("[focus3] startGoogleConnect: fetching /api/google/auth-url");
  const res = await apiFetch("/api/google/auth-url");
  console.log("[focus3] startGoogleConnect: response status", res.status);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error("[focus3] startGoogleConnect failed:", res.status, body);
    throw new CalendarError(
      (body as { message?: string }).message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  const { url } = (await res.json()) as { url: string };
  console.log("[focus3] startGoogleConnect: redirecting to", url.slice(0, 80));
  window.location.href = url;
}

export async function disconnectGoogle(): Promise<void> {
  await apiFetch("/api/google/disconnect", { method: "DELETE" });
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  htmlLink: string | null;
  /** Recurring-series id; same value across every instance of a series. */
  recurringEventId?: string | null;
  /** Source calendar provenance — set when the backend returns multi-calendar data. */
  calendarId?: string | null;
  calendarName?: string | null;
  calendarColor?: string | null;
  /** True when the event came from the user's primary calendar. */
  calendarPrimary?: boolean;
}

export async function deleteEvent(eventId: string): Promise<void> {
  const res = await apiFetch(
    `/api/google/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new CalendarError(body.message ?? `HTTP ${res.status}`, res.status);
  }
}

export interface CalendarMeta {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  primary: boolean;
  selected: boolean;
}

export async function fetchCalendars(): Promise<CalendarMeta[]> {
  const res = await apiFetch("/api/google/calendars");
  if (!res.ok) {
    if (res.status === 401) return [];
    throw new CalendarError(`HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as { calendars: CalendarMeta[] };
  return data.calendars ?? [];
}

export async function fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const res = await apiFetch(`/api/google/events?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 401) return []; // not connected — fail silently
    throw new CalendarError(`HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as { events: CalendarEvent[] };
  return data.events ?? [];
}

// ─── Duplicate audit ──────────────────────────────────────────────────────
export interface DuplicateEvent {
  id: string;
  summary: string;
  start: string | null;
  end: string | null;
  htmlLink: string | null;
}

export interface DuplicateGroup {
  summary: string;
  events: DuplicateEvent[];
}

export async function fetchDuplicates(
  daysBack = 30,
  daysForward = 30,
): Promise<{ groups: DuplicateGroup[]; scanned: number }> {
  const params = new URLSearchParams({
    daysBack: String(daysBack),
    daysForward: String(daysForward),
  });
  const res = await apiFetch(`/api/google/duplicates?${params.toString()}`);
  if (!res.ok) {
    throw new CalendarError(`HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as { groups: DuplicateGroup[]; scanned: number };
}

// ─── Location enrichment ──────────────────────────────────────────────────
export interface LocationCandidate {
  id: string;
  summary: string;
  start: string | null;
  currentLocation: string;
  proposedAddress: string | null;
  confidence: "high" | "medium" | "low";
}

export async function scanAmbiguousLocations(
  daysForward = 30,
): Promise<{ candidates: LocationCandidate[]; scanned: number }> {
  const res = await apiFetch("/api/google/enrich-locations/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daysForward }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new CalendarError(body.message ?? `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as {
    candidates: LocationCandidate[];
    scanned: number;
  };
}

export async function applyLocationUpdates(
  updates: Array<{ id: string; location: string }>,
): Promise<{ updated: number; failures: Array<{ id: string; reason: string }> }> {
  const res = await apiFetch("/api/google/enrich-locations/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) {
    throw new CalendarError(`HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as {
    updated: number;
    failures: Array<{ id: string; reason: string }>;
  };
}

export async function bulkDeleteEvents(
  eventIds: string[],
): Promise<{ deleted: number; failures: Array<{ id: string; reason: string }> }> {
  const res = await apiFetch("/api/google/events/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventIds }),
  });
  if (!res.ok) {
    throw new CalendarError(`HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as {
    deleted: number;
    failures: Array<{ id: string; reason: string }>;
  };
}

/**
 * Push a task to Google Calendar at an explicit start/end time chosen by the user.
 */
export async function scheduleTask(
  task: Task,
  start: Date,
  end: Date,
  options: { weeklyRecurring?: boolean } = {},
): Promise<{ eventId: string; htmlLink?: string }> {
  const res = await apiFetch("/api/google/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: task.title,
      description: task.description ?? "",
      start: start.toISOString(),
      end: end.toISOString(),
      ...(options.weeklyRecurring
        ? { recurrence: ["RRULE:FREQ=WEEKLY"] }
        : {}),
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
