import { useState } from "react";
import {
  bulkDeleteEvents,
  fetchDuplicates,
  type DuplicateGroup,
} from "@/lib/googleCalendar";

/**
 * Calendar duplicate audit — scans the user's primary Google Calendar for
 * events that share a normalized title within a 14-day window and offers to
 * delete the extras.
 *
 * Default policy: keep the EARLIEST event in each cluster, mark every later
 * one for deletion. The user can override by toggling individual checkboxes.
 * Nothing is deleted until the user explicitly clicks "Delete N selected".
 */
export function CalendarDuplicateAudit() {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [scanned, setScanned] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  // Set of event ids the user has marked for deletion. Defaults populated
  // when groups load (everything except the earliest in each cluster).
  const [toDelete, setToDelete] = useState<Set<string>>(new Set());

  const runScan = async () => {
    setError(null);
    setResultMsg(null);
    setLoading(true);
    try {
      const r = await fetchDuplicates(30, 30);
      setGroups(r.groups);
      setScanned(r.scanned);
      // Pre-select all but the first (earliest) in each cluster — the
      // common case is "I pushed the same task multiple times by accident
      // and want to keep one".
      const ids = new Set<string>();
      for (const g of r.groups) {
        for (let i = 1; i < g.events.length; i++) ids.add(g.events[i].id);
      }
      setToDelete(ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : "scan failed");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) => {
    setToDelete((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runDelete = async () => {
    if (toDelete.size === 0) return;
    setError(null);
    setBusyDelete(true);
    try {
      const r = await bulkDeleteEvents(Array.from(toDelete));
      setResultMsg(
        r.failures.length === 0
          ? `Deleted ${r.deleted} duplicate${r.deleted === 1 ? "" : "s"}.`
          : `Deleted ${r.deleted}; ${r.failures.length} failed.`,
      );
      // Re-scan so the cleaned-up groups disappear from the UI.
      await runScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusyDelete(false);
    }
  };

  const fmtTime = (iso: string | null): string => {
    if (!iso) return "(no time)";
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={runScan}
          disabled={loading}
        >
          {loading ? "Scanning…" : "Scan for duplicates"}
        </button>
        {groups && groups.length > 0 && (
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={runDelete}
            disabled={busyDelete || toDelete.size === 0}
          >
            {busyDelete ? "Deleting…" : `Delete ${toDelete.size} selected`}
          </button>
        )}
      </div>

      {error && (
        <p className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
      {resultMsg && (
        <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          {resultMsg}
        </p>
      )}

      {groups !== null && groups.length === 0 && !loading && (
        <p className="text-xs text-slate-500">
          No duplicates found in the last 30 + next 30 days
          {scanned > 0 ? ` (scanned ${scanned} events).` : "."}
        </p>
      )}

      {groups !== null && groups.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Found {groups.length} cluster{groups.length === 1 ? "" : "s"} of
            duplicate events. By default the earliest event in each cluster is
            kept; everything else is checked for deletion. Untick anything you
            want to preserve.
          </p>
          <ul className="space-y-2">
            {groups.map((g, gi) => (
              <li
                key={gi}
                className="rounded-md border border-slate-200 bg-white p-2"
              >
                <p className="text-sm font-medium text-slate-800">{g.summary}</p>
                <ul className="mt-1 space-y-1">
                  {g.events.map((ev, ei) => {
                    const checked = toDelete.has(ev.id);
                    const earliest = ei === 0;
                    return (
                      <li
                        key={ev.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 bg-slate-50 px-2 py-1"
                      >
                        <label className="flex items-center gap-2 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(ev.id)}
                          />
                          <span>{fmtTime(ev.start)}</span>
                          {earliest && !checked && (
                            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700">
                              keeping
                            </span>
                          )}
                          {checked && (
                            <span className="rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0 text-[10px] text-rose-700">
                              will delete
                            </span>
                          )}
                        </label>
                        {ev.htmlLink && (
                          <a
                            href={ev.htmlLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-slate-500 hover:text-slate-900 hover:underline"
                          >
                            open in Google
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
