import type { Task } from "@/types/task";

/**
 * Lightweight notifier — fires browser notifications when:
 *   - a scheduled task / session is starting in the next 5 minutes
 *   - a non-recurring task's dueDate just passed (once per task per day)
 *
 * Dedup is local: we keep a Set of "fired" keys per session. The user gets
 * each notification at most once until they reload.
 */

const fired = new Set<string>();

function notify(title: string, body: string): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, {
      body,
      icon: "/favicon.ico",
      tag: title.slice(0, 40),
    });
  } catch {
    // some browsers throw when called outside a user gesture; harmless
  }
}

export function checkAndNotify(tasks: Task[], now: Date = new Date()): void {
  const startMs = now.getTime();
  const endMs = startMs + 5 * 60 * 1000; // next 5 minutes
  const todayKey = now.toISOString().slice(0, 10);

  for (const t of tasks) {
    if (t.status === "completed") continue;

    // Upcoming scheduled task
    if (t.scheduledFor) {
      const sched = new Date(t.scheduledFor).getTime();
      if (sched >= startMs && sched <= endMs) {
        const key = `start:${t.id}:${t.scheduledFor}`;
        if (!fired.has(key)) {
          fired.add(key);
          notify(
            `Starting soon: ${t.title}`,
            new Date(t.scheduledFor).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
          );
        }
      }
    }

    // Upcoming session
    for (const iso of t.sessionTimes ?? []) {
      const sched = new Date(iso).getTime();
      if (sched >= startMs && sched <= endMs) {
        const key = `session:${t.id}:${iso}`;
        if (!fired.has(key)) {
          fired.add(key);
          notify(
            `Session starting: ${t.title}`,
            new Date(iso).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
          );
        }
      }
    }

    // Overdue dueDate (one-shot tasks only)
    if (t.recurrence === "none" && t.dueDate) {
      const due = new Date(t.dueDate).getTime();
      if (due < startMs && startMs - due < 24 * 60 * 60 * 1000) {
        const key = `overdue:${t.id}:${todayKey}`;
        if (!fired.has(key)) {
          fired.add(key);
          notify(
            `Overdue: ${t.title}`,
            "Due date passed — handle today or snooze",
          );
        }
      }
    }
  }
}
