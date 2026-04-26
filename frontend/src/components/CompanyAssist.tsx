import { useEffect, useMemo, useState } from "react";
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
  /** Locked-in CH number from previous session, if any. */
  lockedNumber?: string;
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

const DATE_FMT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, DATE_FMT);
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
        lockedNumber: t.companyHouseNumber,
        state: "idle",
      });
    }
    return rows;
  }, [tasks]);

  const [rows, setRows] = useState<Row[]>(candidates);
  useEffect(() => setRows(candidates), [candidates]);

  if (candidates.length === 0) return null;

  const lookup = async (idx: number) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, state: "loading", error: undefined } : r)),
    );
    try {
      const row = rows[idx]!;
      const result = await lookupCompany(
        row.lockedNumber
          ? { number: row.lockedNumber }
          : { name: row.companyName },
      );
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
      // Persist on the task so we don't have to ask again.
      const taskId = rows[idx]!.taskId;
      onUpdateTask(taskId, { companyHouseNumber: number });
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx
            ? { ...r, state: "done", result, applied: undefined, lockedNumber: number }
            : r,
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

  const confirmCurrent = (idx: number) => {
    const row = rows[idx]!;
    const number = row.result?.company?.number;
    if (!number) return;
    onUpdateTask(row.taskId, { companyHouseNumber: number });
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx ? { ...r, lockedNumber: number } : r,
      ),
    );
  };

  const resetLock = (idx: number) => {
    onUpdateTask(rows[idx]!.taskId, { companyHouseNumber: undefined });
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? { ...r, lockedNumber: undefined, state: "idle", result: undefined }
          : r,
      ),
    );
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
      companyHouseNumber: row.result?.company?.number,
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
      companyHouseNumber: row.result?.company?.number,
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
          deadlines instead of guessing. Once you confirm a match it sticks —
          use Reset to re-search.
        </p>
      </div>
      <ul className="space-y-3">
        {rows.map((row, idx) => {
          const isFuzzy =
            row.result?.found && row.result.matchType === "fuzzy" && !row.lockedNumber;
          const cardClasses = isFuzzy
            ? "border-amber-300 bg-amber-50/40"
            : row.lockedNumber
            ? "border-emerald-300 bg-emerald-50/30"
            : "border-slate-200 bg-white";
          return (
            <li
              key={`${row.taskId}-${row.companyName}`}
              className={`rounded-md border p-3 text-sm ${cardClasses}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{row.companyName}</span>
                    <span className="text-xs text-slate-500">
                      referenced in "{row.taskTitle}"
                    </span>
                    {row.lockedNumber && (
                      <span
                        className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800"
                        title="You confirmed this match — locked in"
                      >
                        🔒 locked
                      </span>
                    )}
                  </div>
                  {row.result?.found && row.result.company && (
                    <>
                      <div className="mt-1 flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-medium text-slate-800">
                          {row.result.company.name}
                        </span>
                        {isFuzzy && (
                          <span className="rounded-md border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                            ⚠ fuzzy match · verify
                          </span>
                        )}
                        {row.result.matchType === "exact" && !row.lockedNumber && (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800">
                            exact name match
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        #{row.result.company.number} · {row.result.company.status}
                        {row.result.company.incorporated &&
                          ` · incorporated ${fmtDate(row.result.company.incorporated)}`}
                      </p>
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
                <div className="flex flex-col items-end gap-1">
                  {row.state === "idle" && (
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      onClick={() => lookup(idx)}
                    >
                      {row.lockedNumber ? "Refresh" : "Look up"}
                    </button>
                  )}
                  {row.state === "loading" && (
                    <span className="text-xs text-slate-500">checking…</span>
                  )}
                  {row.lockedNumber && (
                    <button
                      type="button"
                      className="text-[11px] text-slate-500 hover:text-red-600"
                      onClick={() => resetLock(idx)}
                      title="Forget this match and re-run search"
                    >
                      reset lock
                    </button>
                  )}
                  {row.result?.found &&
                    !row.lockedNumber &&
                    row.result.company && (
                      <button
                        type="button"
                        className="text-[11px] text-emerald-700 hover:underline"
                        onClick={() => confirmCurrent(idx)}
                        title="Lock this company to the task so we don't ask again"
                      >
                        ✓ confirm match
                      </button>
                    )}
                </div>
              </div>

              {/* Always-visible alternates when fuzzy */}
              {isFuzzy && row.result?.alternates && row.result.alternates.length > 0 && (
                <div className="mt-2 rounded-md border border-amber-200 bg-white p-2 text-xs">
                  <p className="mb-1 font-medium text-amber-900">
                    Other possible matches — click to switch:
                  </p>
                  <ul className="space-y-0.5">
                    {row.result.alternates.map((a) => (
                      <li key={a.number} className="flex items-center gap-2">
                        <button
                          type="button"
                          className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-amber-900 hover:border-amber-500"
                          onClick={() => switchToAlternate(idx, a.number)}
                        >
                          use #{a.number}
                        </button>
                        <span className="truncate text-slate-700">
                          {a.name} <span className="text-slate-400">({a.status})</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {row.state === "done" && row.result?.found && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {row.result.confirmationStatement?.nextDue && (
                    <div className="rounded-md border border-slate-200 bg-white p-2 text-xs">
                      <p className="font-medium">Confirmation statement</p>
                      <p className="text-slate-600">
                        next due{" "}
                        <span className="font-medium text-slate-800">
                          {fmtDate(row.result.confirmationStatement.nextDue)}
                        </span>
                      </p>
                      {row.result.confirmationStatement.nextMadeUpTo && (
                        <p className="text-[11px] text-slate-500">
                          statement date{" "}
                          {fmtDate(row.result.confirmationStatement.nextMadeUpTo)}
                        </p>
                      )}
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
                    <div className="rounded-md border border-slate-200 bg-white p-2 text-xs">
                      <p className="font-medium">Annual accounts</p>
                      <p className="text-slate-600">
                        next due{" "}
                        <span className="font-medium text-slate-800">
                          {fmtDate(row.result.accounts.nextDue)}
                        </span>
                      </p>
                      {row.result.accounts.nextMadeUpTo && (
                        <p className="text-[11px] text-slate-500">
                          year-end {fmtDate(row.result.accounts.nextMadeUpTo)}
                        </p>
                      )}
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
          );
        })}
      </ul>
    </section>
  );
}
