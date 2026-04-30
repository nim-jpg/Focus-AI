import type { Task, Theme, UserType } from "@/types/task";

/**
 * Themes that should count as "work-mode" for a given user type.
 *
 * The /Both / Work / Personal/ toggle filters tasks by these themes
 * — and the toggle's middle-button label adapts too:
 *   - employee  → "Projects" (their day job is "work" but Focus3 is for
 *                 their side ventures and personal life)
 *   - retired   → "Projects" (no day job, so any work-shaped task is a project)
 *   - self-employed → "Work" (their business IS their day job)
 *   - student   → "School" (their studies are their primary commitment)
 *   - other     → "Work" (sensible default)
 */
const PROJECTS_BUCKET: Theme[] = ["projects", "development"];
const SELF_EMPLOYED_WORK_BUCKET: Theme[] = ["work", "projects", "development"];
const STUDENT_BUCKET: Theme[] = ["school", "projects", "development"];

export function workThemesFor(userType?: UserType): Set<Theme> {
  switch (userType) {
    case "self-employed":
      return new Set(SELF_EMPLOYED_WORK_BUCKET);
    case "student":
      return new Set(STUDENT_BUCKET);
    case "retired":
    case "employee":
    case "other":
    default:
      return new Set(PROJECTS_BUCKET);
  }
}

export function workLabelFor(userType?: UserType): string {
  switch (userType) {
    case "self-employed":
      return "Work";
    case "student":
      return "School";
    case "retired":
    case "employee":
    case "other":
    default:
      return "Projects";
  }
}

/** True if the task should appear in the user's "work-mode" view. */
export function isInWorkMode(task: Task, userType?: UserType): boolean {
  return workThemesFor(userType).has(task.theme);
}
