import type { Task } from "@/types/task";
import { extractCompanyName, lookupCompany } from "./companiesHouse";

/**
 * After a task is added, see if its title/description references a UK company.
 * If so, look it up at Companies House and apply the most relevant filing
 * date when we have an *exact* name match — never apply a fuzzy match
 * silently, since that leads to the wrong company's dates.
 *
 * Routing:
 *  - title mentions "confirmation statement" → confirmationStatement.nextDue
 *  - title mentions "annual accounts" or "accounts" → accounts.nextDue
 *  - otherwise: no date change
 *
 * Either way, we tag the description with the company number for traceability.
 */
export async function enrichTaskFromCompaniesHouse(
  task: Task,
  applyPatch: (id: string, patch: Partial<Task>) => void,
): Promise<void> {
  const haystack = `${task.title} ${task.description ?? ""}`;
  const company = extractCompanyName(haystack);
  if (!company) return;

  let result;
  try {
    result = await lookupCompany({ name: company });
  } catch {
    return; // backend down or no API key — silent
  }
  if (!result.found || !result.company) return;
  // Only auto-apply when the search resolved to an exact name match.
  if (result.matchType !== "exact") return;

  const titleLower = task.title.toLowerCase();
  let dueDate: string | undefined;
  if (titleLower.includes("confirmation statement")) {
    dueDate = result.confirmationStatement?.nextDue ?? undefined;
  } else if (
    titleLower.includes("annual accounts") ||
    titleLower.match(/\baccounts\b/)
  ) {
    dueDate = result.accounts?.nextDue ?? undefined;
  }

  const patch: Partial<Task> = {};
  if (dueDate && !task.dueDate) {
    patch.dueDate = new Date(dueDate).toISOString();
  }
  // Always tag the company number into the description if it isn't already there.
  const tag = `Companies House #${result.company.number}`;
  if (!task.description?.includes(tag)) {
    patch.description = task.description
      ? `${task.description}\n${tag}`
      : tag;
  }

  if (Object.keys(patch).length > 0) {
    applyPatch(task.id, patch);
  }
}
