import { useMemo, useState } from "react";
import {
  CompaniesHouseError,
  extractCompanyName,
  lookupCompany,
  type CompaniesHouseLookup,
} from "@/lib/companiesHouse";
import type { Task } from "@/types/task";
import type { NewTaskInput } from "@/lib/useTasks";

interface Props {
  tasks: Task[];
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  onAddTask: (input: NewTaskInput) => void;
}

interface Row {
  taskId: string;
  taskTitle: string;
  companyName: string;
  state: "idle" | "loading" | "done" | "error";
  result?: CompaniesHouseLookup;
  error?: string;
  applied?: { dueDate?: boolean; addedConfirmation?: boolean; addedAccounts?: boolean };
}

function emptyTask(): NewTaskInput {
  return {
    title: "",
    description: "",
    theme: "work",
    estimatedMinutes: 60,
    urgency: "normal",
    privacy: "private",
    isWork: true,
    isBlocker: false,
    blockedBy: [],
    recurrence: "yearly",
    timeOfDay: "anytime",
  };
}

export function CompanyAssist({ tasks, onUpdateTask, onAddTask }: Props) {
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const t of tasks) {
      if (t.status === "completed") continue;
      const haystack = `${t.title} ${t.description ?? ""}`;
      const name = extractCompanyName(haystack);
      if (!name) continue;
      const dedupeKey = `${t.id}:${name.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push({
        taskId: t.id,
        taskTitle: t.title,
        companyName: name,
        state: "idle",
      });
    }
    return rows;
  }, [tasks]);

  const [rows, setRows] = useState<Row[]>([]);
  // re-seed when candidates list changes
  useMemo(() => setRows(candidates), [candidates]);

  if (candidates.length === 0) return null;

  const lookup = async (idx: number) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, state: "loading", error: undefined } : r)),
    );
    try {
      const result = await lookupCompany({ name: rows[idx]!.companyName });
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx ? { ...r, state: "done", result, applied: undefined } : r,
        ),
      );
    } catch (err) {
      const message =
        err instanceof CompaniesHouseError ? err.message : "lookup failed";
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx ? { ...r, state: "error", error: message } : r,
        ),
      );
    }
  };

  const switchToAlternate = async (idx: number, number: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, state: "loading", error: undefined } : r)),
    );
    try {
      const result = await lookupCompany({ number });
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx ? { ...r, state: "done", result, applied: undefined } : r,
        ),
      );
    } catch (err) {
      const message =
        err instanceof CompaniesHouseError ? err.message : "lookup failed";
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx ? { ...r, state: "error", error: message } : r,
        ),
      );
    }
  };

  const applyConfirmationDate = (row: Row, idx: number) => {
    const date = row.result?.confirmationStatement?.nextDue;
    if (!date) return;
    onUpdateTask(row.taskId, { dueDate: new Date(date).toISOString() });
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx ? { ...r, applied: { ...r.applied, dueDate: true } } : r,
      ),
    );
  };

  const addConfirmationStatement = (row: Row, idx: number) => {
    const date = row.result?.confirmationStatement?.nextDue;
    if (!date) return;
    onAddTask({
      ...emptyTask(),
      title: `File confirmation statement for ${row.companyName}`,
      description: `Companies House #${row.result?.company?.number}`,
      dueDate: new Date(date).toISOString(),
      theme: "finance",
      urgency: "high",
      recurrence: "yearly",
    });
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx ? { ...r, applied: { ...r.applied, addedConfirmation: true } } : r,
      ),
    );
  };

  const addAnnualAccounts = (row: Row, idx: number) => {
    const date = row.result?.accounts?.nextDue;
    if (!date) return;
    onAddTask({
      ...emptyTask(),
      title: `File annual accounts for ${row.companyName}`,
      description: `Companies House #${row.result?.company?.number}`,
      dueDate: new Date(date).toISOString(),
      theme: "finance",
      urgency: "high",
      recurrence: "yearly",
    });
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx ? { ...r, applied: { ...r.applied, addedAccounts: true } } : r,
      ),
    );
  };

  return (
    <section>
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-slate-700">Company assist</h2>
        <p className="text-xs text-slate-500">
          Detected UK companies in your tasks. Look up real Companies House
          deadlines instead of guessing.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map((row, idx) => (
          <li
            key={`${row.taskId}-${row.companyName}`}
            className="rounded-md border border-slate-200 bg-white p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{row.companyName}</span>
                  <span className="text-xs text-slate-500">
                    referenced in "{row.taskTitle}"
                  </span>
                </div>
                {row.result?.found && row.result.company && (
                  <>
                    <p className="mt-1 text-xs text-slate-700">
                      <span className="font-medium">{row.result.company.name}</span>
                      {" · "}
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                          row.result.matchType === "fuzzy"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-emerald-100 text-emerald-800"
                        }`}
                        title={
                          row.result.matchType === "fuzzy"
                            ? "Best fuzzy match — verify it's the right company"
                            : "Exact name match"
                        }
                      >
                        {row.result.matchType ?? "match"}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      #{row.result.company.number} · {row.result.company.status}
                      {row.result.company.incorporated &&
                        ` · incorporated ${row.result.company.incorporated}`}
                    </p>
                    {row.result.alternates && row.result.alternates.length > 0 && (
                      <details className="mt-1 text-xs text-slate-600">
                        <summary className="cursor-pointer text-slate-500 hover:text-slate-800">
                          Wrong company? {row.result.alternates.length} alternates
                        </summary>
                        <ul className="mt-1 space-y-0.5 pl-3">
                          {row.result.alternates.map((a) => (
                            <li key={a.number} className="flex items-center gap-2">
                              <button
                                type="button"
                                className="text-emerald-700 hover:underline"
                                onClick={() => switchToAlternate(idx, a.number)}
                              >
                                use #{a.number}
                              </button>
                              <span className="truncate">
                                {a.name} ({a.status})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
                {row.state === "done" && !row.result?.found && (
                  <p className="mt-1 text-xs text-amber-700">
                    No active company found by that name.
                  </p>
                )}
                {row.error && (
                  <p className="mt-1 text-xs text-amber-700">{row.error}</p>
                )}
              </div>
              {row.state === "idle" && (
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => lookup(idx)}
                >
                  Look up
                </button>
              )}
              {row.state === "loading" && (
                <span className="text-xs text-slate-500">checking…</span>
              )}
            </div>

            {row.state === "done" && row.result?.found && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {row.result.confirmationStatement?.nextDue && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
                    <p className="font-medium">Confirmation statement</p>
                    <p className="text-slate-600">
                      next due {row.result.confirmationStatement.nextDue}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="text-emerald-700 hover:underline disabled:text-slate-400"
                        onClick={() => applyConfirmationDate(row, idx)}
                        disabled={row.applied?.dueDate}
                      >
                        {row.applied?.dueDate
                          ? "✓ applied to task"
                          : "Apply to this task"}
                      </button>
                      <span className="text-slate-300">·</span>
                      <button
                        type="button"
                        className="text-emerald-700 hover:underline disabled:text-slate-400"
                        onClick={() => addConfirmationStatement(row, idx)}
                        disabled={row.applied?.addedConfirmation}
                      >
                        {row.applied?.addedConfirmation
                          ? "✓ added"
                          : "Add as separate task"}
                      </button>
                    </div>
                  </div>
                )}
                {row.result.accounts?.nextDue && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
                    <p className="font-medium">Annual accounts</p>
                    <p className="text-slate-600">
                      next due {row.result.accounts.nextDue}
                    </p>
                    <button
                      type="button"
                      className="mt-1 text-emerald-700 hover:underline disabled:text-slate-400"
                      onClick={() => addAnnualAccounts(row, idx)}
                      disabled={row.applied?.addedAccounts}
                    >
                      {row.applied?.addedAccounts
                        ? "✓ added"
                        : "Add as separate task"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
