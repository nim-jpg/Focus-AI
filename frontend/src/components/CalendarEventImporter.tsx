import { useState } from "react";
import { fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import type { Task } from "@/types/task";

interface Props {
  /** Existing tasks — used to skip events already linked via calendarEventId. */
  existingTasks: Task[];
  /** Called per imported task. The hook is the standard addTask so all the
   *  cache-first sync + remote push wiring kicks in automatically. */
  onImport: (input: {
    title: string;
    description?: string;
    theme: Task["theme"];
    urgency: Task["urgency"];
    recurrence: Task["recurrence"];
    privacy: Task["privacy"];
    isWork: boolean;
    isBlocker: boolean;
    calendarEventId?: string;
    estimatedMinutes?: number;
    dueDate?: string;
  }) => void;
}

interface Candidate extends CalendarEvent {
  /** Heuristic theme/urgency seed so the import lands sensibly without
   *  forcing a Claude round-trip per event. The user can edit afterwards. */
  seedTheme: Task["theme"];
  seedUrgency: Task["urgency"];
  seedMinutes: number;
}

/**
 * Import Google Calendar events as Focus3 tasks. The point is two-way work
 * tracking: events you accept on Google should be visible in Focus3's task
 * list with theme + urgency + completion-tracking, while time-of-day stays in
 * Google (scheduledFor stays empty; the link is via calendarEventId).
 *
 * Filters that always apply:
 *  - Events already linked to a Focus3 task (matched by calendarEventId)
 *  - All-day events (usually holidays / leave / birthdays — not actionable
 *    work)
 *  - Events whose title looks like a system / out-of-office marker
 *    ("OOO", "Out of office", "Holiday")
 *
 * The user picks which of the remaining candidates to import via checkbox.
 */
export function CalendarEventImporter({ existingTasks, onImport }: Props) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const runScan = async () => {
    setError(null);
    setResultMsg(null);
    setLoading(true);
    try {
      // 14 days back (recent events you may want to retroactively log) + 30
      // days forward (upcoming work to track).
      const from = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const events = await fetchEvents(from, to);

      const linkedIds = new Set(
        existingTasks
          .map((t) => t.calendarEventId)
          .filter((id): id is string => Boolean(id)),
      );

      const looksOOO = /\b(ooo|out of office|holiday|annual leave|vacation|pto|sick)\b/i;

      const filtered: Candidate[] = events
        .filter((ev) => Boolean(ev.id))
        .filter((ev) => !linkedIds.has(ev.id!))
        .filter((ev) => !ev.allDay)
        .filter((ev) => !looksOOO.test(ev.summary))
        .filter((ev) => Boolean(ev.start) && Boolean(ev.end))
        .map((ev) => seedFor(ev));

      setCandidates(filtered);
      setScanned(events.length);
      // Default: nothing pre-selected. Importing creates tasks, which is a
      // mutation; the user opts in per event.
      setSelected(new Set());
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

  const toggleAll = () => {
    if (!candidates) return;
    if (selected.size === candidates.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(candidates.map((c) => c.id!)));
    }
  };

  const runImport = () => {
    if (!candidates || selected.size === 0) return;
    let imported = 0;
    for (const c of candidates) {
      if (!selected.has(c.id!)) continue;
      onImport({
        title: c.summary,
        description: undefined,
        theme: c.seedTheme,
        urgency: c.seedUrgency,
        recurrence: "none",
        privacy: "private",
        isWork: c.seedTheme === "work",
        isBlocker: false,
        calendarEventId: c.id!,
        estimatedMinutes: c.seedMinutes,
        // Use the event's start date as a soft due date — the time-of-day
        // truth still lives in Google, but a dueDate lets Focus3's
        // urgency/scoring engine notice if it slips past.
        dueDate: c.start ?? undefined,
      });
      imported += 1;
    }
    setResultMsg(
      `Imported ${imported} task${imported === 1 ? "" : "s"} from your calendar.`,
    );
    setCandidates(null);
    setSelected(new Set());
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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={runScan}
          disabled={loading}
        >
          {loading ? "Scanning…" : "Scan upcoming events"}
        </button>
        {candidates && candidates.length > 0 && (
          <>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={toggleAll}
            >
              {selected.size === candidates.length ? "Clear" : "Select all"}
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={runImport}
              disabled={selected.size === 0}
            >
              Import {selected.size} as task{selected.size === 1 ? "" : "s"}
            </button>
          </>
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
          No new events to import — every event in the next 30 days is either
          already linked to a Focus3 task or is an all-day / OOO entry
          {scanned > 0 ? ` (scanned ${scanned}).` : "."}
        </p>
      )}

      {candidates !== null && candidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-slate-500">
            {candidates.length} event{candidates.length === 1 ? "" : "s"} not
            yet tracked in Focus3. Pick which ones to import — they'll appear
            in your task list and link back to the Google event.
          </p>
          <ul className="space-y-1.5">
            {candidates.map((c) => {
              const checked = selected.has(c.id!);
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 bg-white px-2 py-1.5"
                >
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(c.id!)}
                    />
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{c.summary}</span>
                      <span className="ml-2 text-xs text-slate-500">
                        {fmtTime(c.start)}
                      </span>
                    </span>
                  </label>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
                    {c.seedTheme}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Heuristic seed for theme + urgency + duration. Keeps the import zero-cost
 * (no Claude call) while still landing each task somewhere reasonable. The
 * user edits anything that's wrong from the task list.
 */
function seedFor(ev: CalendarEvent): Candidate {
  const t = ev.summary.toLowerCase();
  let seedTheme: Task["theme"] = "work";
  if (/\b(gym|run|workout|yoga|pilates|swim|cycle|ride)\b/.test(t)) {
    seedTheme = "fitness";
  } else if (/\b(doctor|dentist|gp|hospital|clinic|consult|therapy)\b/.test(t)) {
    seedTheme = "medication";
  } else if (/\b(school|nursery|pickup|drop off|class|exam)\b/.test(t)) {
    seedTheme = "school";
  } else if (
    /\b(lunch|dinner|coffee|drinks|brunch|breakfast|catch up|catchup|family|kids)\b/.test(
      t,
    )
  ) {
    seedTheme = "personal";
  }

  const minutes =
    ev.start && ev.end
      ? Math.max(
          5,
          Math.round(
            (new Date(ev.end).getTime() - new Date(ev.start).getTime()) /
              60000,
          ),
        )
      : 30;

  return {
    ...ev,
    seedTheme,
    seedUrgency: "normal",
    seedMinutes: minutes,
  };
}
