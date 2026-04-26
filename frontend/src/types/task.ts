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

export const TIME_OF_DAY = [
  "morning",
  "midday",
  "afternoon",
  "evening",
  "anytime",
] as const;
export type TimeOfDay = (typeof TIME_OF_DAY)[number];

/** State for counter-style foundations (e.g. drink 8 glasses of water). */
export interface DailyCounter {
  target: number;
  /** ISO date (YYYY-MM-DD) of the current day the count applies to. */
  date: string;
  count: number;
}

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
  /** ISO timestamp the task was last marked done. For recurring tasks this drives next-due calculation. */
  lastCompletedAt?: string;
  /** When in the day this task wants to be done. Defaults to "anytime". */
  timeOfDay?: TimeOfDay;
  /** If present, this task is a counter (e.g. drink 8 glasses). Tap-to-increment instead of tick-once. */
  counter?: DailyCounter;
  /** Goals this task ladders up to. */
  goalIds?: string[];
  /** ISO timestamp the task is hidden until. Used for "blocked externally, recheck in N days". */
  snoozedUntil?: string;
  /** ISO timestamp this task is locally scheduled for (e.g. drag onto a time slot in the day overlay). Independent of Google Calendar. */
  scheduledFor?: string;
  /** When true, this task is treated as a Foundation regardless of theme/recurrence. Keeps it out of Top Three. */
  treatAsFoundation?: boolean;
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

export const GOAL_HORIZONS = ["6m", "1y", "5y", "10y"] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];

/** Source of the goal — manual entry today; future Fitness/Finance apps may push goals. */
export type GoalSource = "manual" | "fitness-app" | "finance-app";

export interface Goal {
  id: string;
  title: string;
  horizon: GoalHorizon;
  theme: Theme;
  /** Free-form note about why this matters / target metric. */
  notes?: string;
  /** Internal — hidden from UI. Defaults to "manual". */
  source: GoalSource;
  createdAt: string;
  updatedAt: string;
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
