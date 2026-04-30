import { apiFetch } from "./api";
import { isAuthEnabled } from "./supabaseClient";

/**
 * Fire-and-forget metrics logger. Sends a single event to the backend, which
 * stores user_id + event_type + (optional) metadata in Supabase. NEVER pass
 * task content here — only counts and non-PII context.
 *
 * Privacy contract: the entire `metadata` blob is searchable by an admin, so
 * keep it boring (route names, success/failure, ints). If you find yourself
 * wanting to send a title, take a step back and reconsider.
 *
 * In single-user / local-dev mode (no Supabase configured), this no-ops.
 */
export type MetricEventType =
  | "task_created"
  | "task_completed"
  | "task_uncompleted"
  | "task_deleted"
  | "goal_created"
  | "goal_deleted"
  | "calendar_event_pushed"
  | "calendar_event_unscheduled"
  | "calendar_event_imported"
  | "backup_exported"
  | "backup_imported"
  | "session_signed_in";

export function logEvent(
  eventType: MetricEventType,
  metadata?: Record<string, string | number | boolean | null>,
): void {
  if (!isAuthEnabled()) return;
  void apiFetch("/api/metrics/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventType, metadata }),
  }).catch(() => {
    // Silently swallow — metrics never block the user.
  });
}
