export const THEMES = [
  "work",
  "projects",
  "personal",
  "school",
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
  /** YYYY-MM-DD strings of every day this task was marked done. Used for habit streaks. Only relevant for recurring tasks. */
  completionLog?: string[];
  /** When in the day this task wants to be done. Defaults to "anytime". */
  timeOfDay?: TimeOfDay;
  /** Optional specific time-of-day override (HH:MM, 24-hour). Useful for daily habits like "8:30 tablets". */
  specificTime?: string;
  /** For tasks that need multiple sessions per week (e.g. 3 weight training sessions). The UI / planner can spread these across the week. */
  sessionsPerWeek?: number;
  /** Auto-scheduled / manually-set instances of a multi-session task for the current week. ISO timestamps. */
  sessionTimes?: string[];
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
  /** Companies House number locked-in for this task. When set, lookups skip the fuzzy search and fetch this company directly. Cleared via the "Reset" button in Company Assist. */
  companyHouseNumber?: string;
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

export const USER_TYPES = [
  "employee",
  "self-employed",
  "student",
  "retired",
  "other",
] as const;
export type UserType = (typeof USER_TYPES)[number];

/** App-wide user preferences. */
export interface UserPrefs {
  /** Display name for the user. When set, prints on the PDF header as
   *  "Focus3 - <name> - Weekly Planner". */
  displayName?: string;
  /** What's the user's primary occupation context? Used to shape defaults
   *  (working hours flexibility, theme suggestions, etc.). */
  userType: UserType;
  workingHoursStart: string; // "09:00"
  workingHoursEnd: string; // "18:00"
  /** Day-of-week numbers (0=Sun..6=Sat) the user typically works. */
  workingDays: number[];
  mode: "both" | "work" | "personal";
  googleCalendarConnected: boolean;
  /** Whether the user has opted in to browser notifications for due/overdue tasks. */
  notificationsEnabled: boolean;
  /** Themes whose tasks should be EXCLUDED from the printed PDF planner.
   *  Defaults to ["medication"] — sensitive content stays off paper unless the user opts in. */
  pdfExcludeThemes: Theme[];
  /** @deprecated kept for migration; treated as `excludedCalendarIds`. */
  privateCalendarIds?: string[];
  /** Google Calendar IDs treated as SHADOW — events show on the schedule
   *  faintly (so you're aware) but don't block auto-scheduling. Useful
   *  for partner/family calendars where you want context but the event
   *  doesn't directly take your time. */
  shadowCalendarIds: string[];
  /** Google Calendar IDs to EXCLUDE entirely — events from these don't
   *  show on the schedule and don't count as busy time. */
  excludedCalendarIds: string[];
  /** Subset of workingDays that are office days (commute applies). */
  officeDays: number[];
  /** Single-leg commute time in minutes. Applied before AND after the working
   *  day on office days, both for visualisation and auto-schedule. */
  commuteMinutes: number;
  /** Wake-up time (HH:MM). Auto-schedule won't place a slot earlier than
   *  wakeUpTime + 30 minutes. Defaults to 07:00. */
  wakeUpTime?: string;
  /** Bedtime (HH:MM). Auto-schedule won't place a slot later than
   *  bedTime - 1 hour. Defaults to 23:00. */
  bedTime?: string;
  /** Buffer in minutes around commute on office days, beyond commute itself.
   *  E.g. 30 means slots can't sit within 30 min of commute start/end.
   *  Defaults to 30. */
  commuteBufferMinutes?: number;
  /** Local colour overrides per Google Calendar id (hex `#rrggbb`). When
   *  present, beats Google's own backgroundColor in the schedule view. */
  calendarColorOverrides?: Record<string, string>;
  /** Specific Google event ids the user has chosen to hide from the Focus3
   *  schedule. The event still exists in Google; this is a local mute. */
  ignoredEventIds?: string[];
  /** Recurring-series ids (Google's recurringEventId) the user has muted —
   *  hides every instance of the series from Focus3. */
  ignoredSeriesIds?: string[];
  /** Per-event shadow: stays visible (light grey) on the schedule but
   *  doesn't block auto-scheduling. Like the per-calendar shadow but
   *  scoped to a single event id. */
  shadowedEventIds?: string[];
  /** Per-series shadow — applies the same treatment to every instance of
   *  a recurring series (Google's recurringEventId). */
  shadowedSeriesIds?: string[];
  /** Default home-page schedule range: 1, 3, or 7 days. */
  homeViewDays?: 1 | 3 | 7;
  /** Specific dates the user has marked as holidays — working-hours
   *  shading is suppressed and the day is treated as non-working. ISO
   *  date strings ("YYYY-MM-DD"). */
  holidayDates?: string[];
}

export const DEFAULT_PREFS: UserPrefs = {
  userType: "employee",
  workingHoursStart: "09:00",
  workingHoursEnd: "18:00",
  workingDays: [1, 2, 3, 4, 5], // Mon-Fri
  mode: "both",
  googleCalendarConnected: false,
  notificationsEnabled: false,
  pdfExcludeThemes: ["medication"],
  shadowCalendarIds: [],
  excludedCalendarIds: [],
  officeDays: [],
  commuteMinutes: 0,
  wakeUpTime: "07:00",
  bedTime: "23:00",
  commuteBufferMinutes: 30,
  calendarColorOverrides: {},
  ignoredEventIds: [],
  ignoredSeriesIds: [],
  shadowedEventIds: [],
  shadowedSeriesIds: [],
  homeViewDays: 7,
};
