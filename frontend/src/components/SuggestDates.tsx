import { useState } from "react";
import {
  suggestDueDates,
  SuggestUnavailableError,
  type DateSuggestion,
} from "@/lib/suggestDates";
import type { Task } from "@/types/task";

interface Props {
  tasks: Task[];
  onApply: (taskId: string, dueDate: string) => void;
}

const CONFIDENCE_CLASSES: Record<DateSuggestion["confidence"], string> = {
  high: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

export function SuggestDates({ tasks, onApply }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<DateSuggestion[] | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

  const undatedCount = tasks.filter(
    (t) => !t.dueDate && t.status !== "completed",
  ).length;

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    setSuggestions(null);
    setAppliedIds(new Set());
    try {
      const result = await suggestDueDates(tasks);
      if (result.length === 0) {
        setError("Claude couldn't infer any dates from your undated tasks.");
      } else {
        setSuggestions(result);
      }
    } catch (err) {
      setError(
        err instanceof SuggestUnavailableError
          ? err.message
          : "unexpected error",
      );
    } finally {
      setLoading(false);
    }
  };

  const titleFor = (id: string) =>
    tasks.find((t) => t.id === id)?.title ?? "(unknown task)";

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            Suggest due dates
          </h2>
          <p className="text-xs text-slate-500">
            {undatedCount} task{undatedCount === 1 ? "" : "s"} without a deadline.
            Claude infers dates from common patterns (filings, VAT quarters,
            "by Friday").
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleRun}
          disabled={loading || undatedCount === 0}
        >
          {loading ? "Asking Claude…" : "Suggest"}
        </button>
      </div>
      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error}
        </div>
      )}
      {suggestions && (
        <ul className="space-y-2">
          {suggestions.map((s) => {
            const applied = appliedIds.has(s.taskId);
            return (
              <li
                key={s.taskId}
                className="flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-white p-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{titleFor(s.taskId)}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${CONFIDENCE_CLASSES[s.confidence]}`}
                    >
                      {s.confidence}
                    </span>
                    <span className="text-xs text-slate-600">
                      → {new Date(s.dueDate).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{s.reasoning}</p>
                </div>
                <button
                  type="button"
                  className={applied ? "text-xs text-emerald-700" : "btn-secondary text-xs"}
                  onClick={() => {
                    onApply(s.taskId, new Date(s.dueDate).toISOString());
                    setAppliedIds((prev) => {
                      const next = new Set(prev);
                      next.add(s.taskId);
                      return next;
                    });
                  }}
                  disabled={applied}
                >
                  {applied ? "✓ applied" : "Apply"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
