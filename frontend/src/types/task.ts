export const THEMES = [
  "work",
  "personal",
  "fitness",
  "finance",
  "diet",
  "medication",
  "development",
  "household",
] as const;

export type Theme = (typeof THEMES)[number];

export const PRIVACY_LEVELS = ["private", "semi-private", "public"] as const;
export type Privacy = (typeof PRIVACY_LEVELS)[number];

export const URGENCY_LEVELS = ["low", "normal", "high", "critical"] as const;
export type Urgency = (typeof URGENCY_LEVELS)[number];

export const RECURRENCE_PATTERNS = [
  "none",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;
export type Recurrence = (typeof RECURRENCE_PATTERNS)[number];

export type TaskStatus = "pending" | "completed" | "delayed";

export interface Task {
  id: string;
  title: string;
  description?: string;
  theme: Theme;
  /** Hours estimated to complete; used by calendar block suggestions. */
  estimatedMinutes?: number;
  /** ISO date string. */
  dueDate?: string;
  urgency: Urgency;
  privacy: Privacy;
  /** True if task is part of a work context (gates Work Mode views). */
  isWork: boolean;
  /** True if task unlocks downstream work; weights it higher. */
  isBlocker: boolean;
  /** IDs this task depends on (must be completed first). */
  blockedBy?: string[];
  recurrence: Recurrence;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** ISO date the task was last surfaced in Top Three but not actioned. */
  lastSurfacedAt?: string;
  /** Number of weeks the user has avoided this task. */
  avoidanceWeeks?: number;
  /** Optional Google Calendar event id once scheduled. */
  calendarEventId?: string;
}

/** Output of the prioritization engine. */
export interface PrioritizedTask {
  task: Task;
  /** Numeric score; higher = more important. */
  score: number;
  /** Tier label per spec. */
  tier: 1 | 2 | 3 | 4;
  /** One-line human-readable reasoning. */
  reasoning: string;
}

/** App-wide user preferences. */
export interface UserPrefs {
  workingHoursStart: string; // "09:00"
  workingHoursEnd: string; // "17:00"
  mode: "both" | "work" | "personal";
  googleCalendarConnected: boolean;
}

export const DEFAULT_PREFS: UserPrefs = {
  workingHoursStart: "09:00",
  workingHoursEnd: "17:00",
  mode: "both",
  googleCalendarConnected: false,
};
