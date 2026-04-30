import type { Task, TaskKind } from "@/types/task";

/**
 * Infer the task kind from explicit field, then convention.
 *
 * Order matters — earliest match wins. Explicit `task.kind` always overrides;
 * after that we look at structural signals (followUpToTaskId, calendarEventId,
 * recurrence) before falling back to title pattern matching.
 *
 * Title patterns are deliberately a small, opinionated set — they're meant to
 * catch the obvious cases ("call mum", "decide on supplier", "pick up dry
 * cleaning") without trying to outsmart the user. When unsure we say "action"
 * and let the user override on Desktop.
 */
export function inferTaskKind(task: Task): TaskKind {
  if (task.kind) return task.kind;
  if (task.followUpToTaskId) return "follow-up";
  if (task.calendarEventId) return "appointment";
  if (task.recurrence && task.recurrence !== "none") return "habit";

  const title = (task.title ?? "").toLowerCase().trim();

  // Communication — verbs that imply contacting someone
  if (
    /^(call|ring|phone|email|reply to|text|message|dm|whatsapp|chase|nudge|follow up with)\b/.test(
      title,
    )
  ) {
    return "communication";
  }

  // Decision — needs thought, not hands
  if (
    /^(decide|choose|pick|figure out|work out|think (about|through)|plan|review options|weigh)\b/.test(
      title,
    )
  ) {
    return "decision";
  }

  // Errand — physical fetch / drop / shop
  if (
    /^(pick up|drop off|collect|return|post|deliver|fetch|grab|buy|grocery|shop|order)\b/.test(
      title,
    ) ||
    /\b(dry cleaning|prescription|parcel|package|takeaway)\b/.test(title)
  ) {
    return "errand";
  }

  return "action";
}

/** Tasks that are "doable work" — what should appear on the Focus stretch list.
 *  Appointments are excluded (already booked, prep belongs in Hyper Focus).
 *  Habits are excluded (live in Hyper Focus basics). */
const ACTIONABLE_KINDS: ReadonlySet<TaskKind> = new Set([
  "action",
  "follow-up",
  "errand",
  "decision",
  "communication",
]);

export function isActionable(task: Task): boolean {
  return ACTIONABLE_KINDS.has(inferTaskKind(task));
}

/** Short label for chip display. Verb-adjacent, lowercase, no emoji here —
 *  emoji lives in kindGlyph() so we can render glyph-only or label-only. */
export function kindLabel(kind: TaskKind): string {
  switch (kind) {
    case "action":
      return "action";
    case "appointment":
      return "appt";
    case "follow-up":
      return "follow-up";
    case "errand":
      return "errand";
    case "decision":
      return "decide";
    case "communication":
      return "comms";
    case "habit":
      return "habit";
  }
}

export function kindGlyph(kind: TaskKind): string {
  switch (kind) {
    case "action":
      return "▸";
    case "appointment":
      return "📅";
    case "follow-up":
      return "↻";
    case "errand":
      return "🛒";
    case "decision":
      return "🤔";
    case "communication":
      return "💬";
    case "habit":
      return "♾";
  }
}
