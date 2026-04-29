import { useState } from "react";
import {
  applyLocationUpdates,
  scanAmbiguousLocations,
  type LocationCandidate,
} from "@/lib/googleCalendar";

/**
 * Location enrichment for Google Calendar events.
 *
 * Scans upcoming primary-calendar events whose `location` field is short or
 * ambiguous (e.g. "Costa", "head office", a landmark name without postcode)
 * and asks Claude — given the event title as context — to propose a fuller
 * postal address. The user reviews + approves before any writeback. Focus3
 * itself never stores the location; this is a one-way enrichment of the
 * Google source.
 *
 * Edits per row:
 *   - Click into the proposed-address textbox to refine before applying.
 *   - Untick to skip an event.
 */
export function CalendarLocationEnrich() {
  const [candidates, setCandidates] = useState<LocationCandidate[] | null>(
    null,
  );
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busyApply, setBusyApply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  // selected = whether to write the address back. drafts = the address text
  // (starts at the proposed address but the user can refine before applying).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const runScan = async () => {
    setError(null);
    setResultMsg(null);
    setLoading(true);
    try {
      const r = await scanAmbiguousLocations(30);
      setCandidates(r.candidates);
      setScanned(r.scanned);
      // Pre-select rows where Claude returned a confident proposal.
      // Low-confidence + null rows stay unchecked so the user has to opt in.
      const sel = new Set<string>();
      const d: Record<string, string> = {};
      for (const c of r.candidates) {
        if (c.proposedAddress && c.confidence !== "low") sel.add(c.id);
        d[c.id] = c.proposedAddress ?? "";
      }
      setSelected(sel);
      setDrafts(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "scan failed");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runApply = async () => {
    if (!candidates || selected.size === 0) return;
    setError(null);
    setBusyApply(true);
    try {
      const updates = candidates
        .filter((c) => selected.has(c.id))
        .map((c) => ({ id: c.id, location: drafts[c.id] ?? "" }))
        .filter((u) => u.location.trim().length > 0);
      if (updates.length === 0) {
        setError("Nothing to apply — all selected rows have empty addresses.");
        setBusyApply(false);
        return;
      }
      const r = await applyLocationUpdates(updates);
      setResultMsg(
        r.failures.length === 0
          ? `Updated ${r.updated} event location${r.updated === 1 ? "" : "s"} in Google.`
          : `Updated ${r.updated}; ${r.failures.length} failed (check the events directly).`,
      );
      // Re-scan so applied rows drop off.
      await runScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : "apply failed");
    } finally {
      setBusyApply(false);
    }
  };

  const fmtTime = (iso: string | null): string => {
    if (!iso) return "";
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const confidenceBadge = (c: "high" | "medium" | "low") => {
    if (c === "high") {
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    }
    if (c === "medium") {
      return "border-amber-300 bg-amber-50 text-amber-800";
    }
    return "border-slate-300 bg-slate-50 text-slate-600";
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
          {loading ? "Scanning + asking Claude…" : "Scan for ambiguous locations"}
        </button>
        {candidates && candidates.length > 0 && (
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={runApply}
            disabled={busyApply || selected.size === 0}
          >
            {busyApply
              ? "Updating Google…"
              : `Apply ${selected.size} update${selected.size === 1 ? "" : "s"}`}
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

      {candidates !== null && candidates.length === 0 && !loading && (
        <p className="text-xs text-slate-500">
          No ambiguous locations found in the next 30 days
          {scanned > 0 ? ` (scanned ${scanned} events).` : "."}
        </p>
      )}

      {candidates !== null && candidates.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            {candidates.length} event{candidates.length === 1 ? "" : "s"} have
            a short or ambiguous location. High/medium-confidence proposals
            from Claude are pre-selected. Edit the address inline before
            applying — nothing's written to Google until you click Apply.
          </p>
          <ul className="space-y-2">
            {candidates.map((c) => {
              const checked = selected.has(c.id);
              return (
                <li
                  key={c.id}
                  className="rounded-md border border-slate-200 bg-white p-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex min-w-0 flex-1 items-start gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(c.id)}
                        className="mt-1"
                      />
                      <div className="min-w-0">
                        <div className="font-medium">{c.summary}</div>
                        <div className="text-xs text-slate-500">
                          {fmtTime(c.start)}
                        </div>
                        <div className="mt-0.5 text-xs">
                          <span className="text-slate-500">currently:</span>{" "}
                          <span className="text-slate-800">
                            {c.currentLocation}
                          </span>
                        </div>
                      </div>
                    </label>
                    <span
                      className={`rounded-full border px-1.5 py-0.5 text-[10px] ${confidenceBadge(
                        c.confidence,
                      )}`}
                    >
                      {c.confidence}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <label className="text-[10px] uppercase tracking-wide text-slate-500">
                      Proposed address
                    </label>
                    <input
                      type="text"
                      className="input mt-0.5 text-xs"
                      placeholder={
                        c.proposedAddress
                          ? c.proposedAddress
                          : "Claude couldn't resolve this — type the real address to apply"
                      }
                      value={drafts[c.id] ?? ""}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [c.id]: e.target.value,
                        }))
                      }
                      disabled={!checked}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
