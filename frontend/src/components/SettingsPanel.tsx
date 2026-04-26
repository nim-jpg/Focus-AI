import { useEffect, useRef, useState } from "react";
import {
  THEMES,
  USER_TYPES,
  type Theme,
  type UserPrefs,
  type UserType,
} from "@/types/task";
import { TimeField } from "./TimeField";
import { fetchCalendars, type CalendarMeta } from "@/lib/googleCalendar";

interface Props {
  prefs: UserPrefs;
  onChange: (patch: Partial<UserPrefs>) => void;
  onClose: () => void;
  /** Optional backup hooks; when omitted the section is hidden. */
  onExport?: () => void;
  onImport?: (file: File) => Promise<void>;
  /** Calendar status + connect/disconnect actions. When undefined the section is hidden. */
  calendar?: {
    configured: boolean;
    connected: boolean;
    email?: string | null;
    onConnect: () => void | Promise<void>;
    onDisconnect: () => Promise<void> | void;
  };
}

const DAY_LABELS: Array<{ idx: number; label: string }> = [
  { idx: 1, label: "Mon" },
  { idx: 2, label: "Tue" },
  { idx: 3, label: "Wed" },
  { idx: 4, label: "Thu" },
  { idx: 5, label: "Fri" },
  { idx: 6, label: "Sat" },
  { idx: 0, label: "Sun" },
];

export function SettingsPanel({
  prefs,
  onChange,
  onClose,
  onExport,
  onImport,
  calendar,
}: Props) {
  const [permState, setPermState] = useState<NotificationPermission | null>(
    typeof Notification !== "undefined" ? Notification.permission : null,
  );
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [calendars, setCalendars] = useState<CalendarMeta[] | null>(null);
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);

  // Pull the user's Google calendars when the Calendar section is visible.
  useEffect(() => {
    if (!calendar?.connected) return;
    void fetchCalendars().then(setCalendars).catch(() => setCalendars([]));
  }, [calendar?.connected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleDay = (idx: number) => {
    const next = prefs.workingDays.includes(idx)
      ? prefs.workingDays.filter((d) => d !== idx)
      : [...prefs.workingDays, idx];
    onChange({ workingDays: next.sort((a, b) => a - b) });
  };

  const enableNotifications = async () => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      setPermState(result);
      if (result === "granted") onChange({ notificationsEnabled: true });
    } else if (Notification.permission === "granted") {
      onChange({ notificationsEnabled: !prefs.notificationsEnabled });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 px-4 py-6"
      onClick={onClose}
    >
      <div
        className="my-auto flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold">Settings</h3>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-900"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">

        <div className="space-y-5">
          {/* User type — shapes how Focus3 reads your day */}
          <section>
            <h4 className="text-sm font-semibold text-slate-700">
              I'm an…
            </h4>
            <p className="text-xs text-slate-500">
              Shapes how brain-dumps are tagged. Employees: company / dev work
              you do on the side counts as "projects". Self-employed: your
              business work counts as "work". Retired: any work-shaped task
              counts as "projects".
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {USER_TYPES.map((t) => {
                const active = (prefs.userType ?? "employee") === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onChange({ userType: t as UserType })}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                    }`}
                  >
                    {t.replace("-", " ")}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Working hours */}
          <section>
            <h4 className="text-sm font-semibold text-slate-700">
              Working hours
            </h4>
            <p className="text-xs text-slate-500">
              Used by auto-schedule to avoid placing sessions during work,
              and to tint the week grid.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <div>
                <label className="text-xs text-slate-600">Start</label>
                <TimeField
                  value={prefs.workingHoursStart}
                  onChange={(v) => v && onChange({ workingHoursStart: v })}
                  minuteStep={15}
                />
              </div>
              <div>
                <label className="text-xs text-slate-600">End</label>
                <TimeField
                  value={prefs.workingHoursEnd}
                  onChange={(v) => v && onChange({ workingHoursEnd: v })}
                  minuteStep={15}
                />
              </div>
            </div>
          </section>

          {/* Working days */}
          <section>
            <h4 className="text-sm font-semibold text-slate-700">
              Working days
            </h4>
            <p className="text-xs text-slate-500">
              Tap each day you typically work. Auto-schedule treats other
              days as free for sessions.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DAY_LABELS.map((d) => {
                const active = prefs.workingDays.includes(d.idx);
                return (
                  <button
                    key={d.idx}
                    type="button"
                    onClick={() => toggleDay(d.idx)}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Office days + commute */}
          <section>
            <h4 className="text-sm font-semibold text-slate-700">
              Office days &amp; commute
            </h4>
            <p className="text-xs text-slate-500">
              On office days, your commute is treated as busy time so
              auto-schedule won't put a session there.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DAY_LABELS.map((d) => {
                const isWorking = prefs.workingDays.includes(d.idx);
                const active = (prefs.officeDays ?? []).includes(d.idx);
                return (
                  <button
                    key={d.idx}
                    type="button"
                    disabled={!isWorking}
                    onClick={() => {
                      const cur = prefs.officeDays ?? [];
                      const next = cur.includes(d.idx)
                        ? cur.filter((x) => x !== d.idx)
                        : [...cur, d.idx];
                      onChange({ officeDays: next.sort((a, b) => a - b) });
                    }}
                    className={`rounded-full border px-3 py-1 text-xs disabled:opacity-40 ${
                      active
                        ? "border-amber-600 bg-amber-500 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                    }`}
                    title={isWorking ? "" : "Not a working day"}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              <label className="text-slate-700">Commute (one way, minutes)</label>
              <input
                type="number"
                min={0}
                max={300}
                step={5}
                className="input h-7 w-20 text-xs"
                value={prefs.commuteMinutes ?? 0}
                onChange={(e) =>
                  onChange({ commuteMinutes: Number(e.target.value) || 0 })
                }
              />
            </div>
          </section>

          {/* PDF privacy */}
          <section>
            <h4 className="text-sm font-semibold text-slate-700">
              PDF — themes to exclude
            </h4>
            <p className="text-xs text-slate-500">
              Tasks with these themes are kept off the printable planner.
              Useful for sensitive content (defaults to medication).
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {THEMES.map((theme) => {
                const excluded = (prefs.pdfExcludeThemes ?? []).includes(theme);
                return (
                  <button
                    key={theme}
                    type="button"
                    onClick={() => {
                      const current = prefs.pdfExcludeThemes ?? [];
                      const next = excluded
                        ? current.filter((t) => t !== theme)
                        : [...current, theme as Theme];
                      onChange({ pdfExcludeThemes: next });
                    }}
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      excluded
                        ? "border-red-300 bg-red-50 text-red-800 line-through"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                    title={excluded ? "Excluded — click to include" : "Click to exclude"}
                  >
                    {theme}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Notifications */}
          <section>
            <h4 className="text-sm font-semibold text-slate-700">
              Notifications
            </h4>
            <p className="text-xs text-slate-500">
              Browser notifications when a scheduled task or session starts,
              and a daily nudge for overdue items.
            </p>
            {typeof Notification === "undefined" ? (
              <p className="mt-2 text-xs text-amber-700">
                This browser doesn't support notifications.
              </p>
            ) : permState === "denied" ? (
              <p className="mt-2 text-xs text-amber-700">
                Notifications are blocked at the OS / browser level. Enable
                them in your browser settings to use this feature.
              </p>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => void enableNotifications()}
                >
                  {permState === "granted"
                    ? prefs.notificationsEnabled
                      ? "Disable"
                      : "Enable"
                    : "Enable notifications"}
                </button>
                <span className="text-xs text-slate-500">
                  {permState === "granted"
                    ? prefs.notificationsEnabled
                      ? "On"
                      : "Off (permission granted)"
                    : "Permission required"}
                </span>
              </div>
            )}
          </section>

          {/* Calendar */}
          {calendar && (
            <section>
              <h4 className="text-sm font-semibold text-slate-700">
                Google Calendar
              </h4>
              <p className="text-xs text-slate-500">
                {calendar.connected
                  ? `Connected as ${calendar.email ?? "(unknown)"}.`
                  : "Not connected."}
              </p>
              {calendar.connected && (
                <div className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                  <p className="mb-1 text-xs font-medium text-slate-700">
                    Per-calendar mode
                  </p>
                  <p className="mb-2 text-[11px] text-slate-500">
                    <span className="font-medium">Block</span>: events show and
                    count as busy time.{" "}
                    <span className="font-medium">Shadow</span>: events show
                    faintly so you're aware but they DON'T block your
                    auto-schedule (e.g. family / partner calendars).{" "}
                    <span className="font-medium">Exclude</span>: events are
                    hidden entirely and don't count as busy.
                  </p>
                  {!calendars && (
                    <p className="text-[11px] italic text-slate-400">
                      loading calendars…
                    </p>
                  )}
                  {calendars && calendars.length === 0 && (
                    <p className="text-[11px] italic text-slate-400">
                      No calendars returned. Try clicking Disconnect &amp;
                      reconnect.
                    </p>
                  )}
                  {calendars && calendars.length > 0 && (() => {
                    type Mode = "block" | "shadow" | "exclude";
                    const excludedSet = new Set([
                      ...(prefs.excludedCalendarIds ?? []),
                      ...(prefs.privateCalendarIds ?? []),
                    ]);
                    const shadowSet = new Set(prefs.shadowCalendarIds ?? []);
                    const modeOf = (id: string): Mode =>
                      excludedSet.has(id)
                        ? "exclude"
                        : shadowSet.has(id)
                        ? "shadow"
                        : "block";
                    // Excluded calendars sort to the bottom; primary first
                    // within each group, then alphabetical.
                    const sorted = [...calendars].sort((a, b) => {
                      const ae = modeOf(a.id) === "exclude" ? 1 : 0;
                      const be = modeOf(b.id) === "exclude" ? 1 : 0;
                      if (ae !== be) return ae - be;
                      const ap = a.primary ? 0 : 1;
                      const bp = b.primary ? 0 : 1;
                      if (ap !== bp) return ap - bp;
                      return a.name.localeCompare(b.name);
                    });
                    const setMode = (id: string, m: Mode) => {
                      const ex = new Set(excludedSet);
                      const sh = new Set(shadowSet);
                      ex.delete(id);
                      sh.delete(id);
                      if (m === "exclude") ex.add(id);
                      else if (m === "shadow") sh.add(id);
                      onChange({
                        excludedCalendarIds: Array.from(ex),
                        shadowCalendarIds: Array.from(sh),
                        // Drop the deprecated field so it stops shadowing
                        // the new state on next render.
                        privateCalendarIds: [],
                      });
                    };
                    return (
                      <ul
                        className="space-y-1.5 overflow-y-auto pr-1"
                        // ~6 rows visible (each ~28px incl. gap), scroll the rest
                        style={{ maxHeight: "180px" }}
                      >
                        {sorted.map((c) => {
                          const mode = modeOf(c.id);
                          return (
                            <li
                              key={c.id}
                              className={`flex flex-wrap items-center gap-2 text-xs ${
                                mode === "exclude" ? "opacity-60" : ""
                              }`}
                            >
                              {c.color && (
                                <span
                                  className="inline-block h-3 w-3 rounded-sm"
                                  style={{ backgroundColor: c.color }}
                                />
                              )}
                              <span className="flex-1 truncate">
                                {c.name}
                                {c.primary && (
                                  <span className="ml-1 text-slate-400">
                                    (primary)
                                  </span>
                                )}
                              </span>
                              <div className="flex gap-1">
                                {(["block", "shadow", "exclude"] as const).map(
                                  (m) => (
                                    <button
                                      key={m}
                                      type="button"
                                      onClick={() => setMode(c.id, m)}
                                      className={`rounded-full border px-2 py-0.5 text-[10px] ${
                                        mode === m
                                          ? "border-slate-900 bg-slate-900 text-white"
                                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                                      }`}
                                    >
                                      {m}
                                    </button>
                                  ),
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()}
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!calendar.connected && (
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    disabled={connectBusy}
                    onClick={async () => {
                      setConnectMsg(null);
                      setConnectBusy(true);
                      try {
                        await calendar.onConnect();
                      } catch (err) {
                        setConnectMsg(
                          err instanceof Error
                            ? `Connect failed — ${err.message}`
                            : "Connect failed",
                        );
                      } finally {
                        setConnectBusy(false);
                      }
                    }}
                  >
                    {connectBusy ? "Opening Google…" : "Connect Calendar"}
                  </button>
                )}
                {!calendar.configured && (
                  <span className="text-xs text-amber-700">
                    Google OAuth isn't configured on the server.
                  </span>
                )}
                {calendar.connected && (
                  <button
                    type="button"
                    className="text-xs text-red-600 hover:text-red-800"
                    onClick={() => {
                      if (
                        confirm(
                          "Disconnect Google Calendar? Your tasks stay; we'll forget your Google tokens.",
                        )
                      ) {
                        void calendar.onDisconnect();
                      }
                    }}
                  >
                    Disconnect Calendar
                  </button>
                )}
              </div>
              {connectMsg && (
                <p className="mt-2 text-xs text-amber-700">{connectMsg}</p>
              )}
            </section>
          )}

          {/* Backup / restore */}
          {(onExport || onImport) && (
            <section>
              <h4 className="text-sm font-semibold text-slate-700">
                Backup & restore
              </h4>
              <p className="text-xs text-slate-500">
                Export everything (tasks, goals, prefs) as a JSON file you
                can save somewhere safe. Restore overwrites current data.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {onExport && (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={onExport}
                  >
                    Export backup
                  </button>
                )}
                {onImport && (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="application/json"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (
                          !confirm(
                            "Restore will overwrite all current tasks, goals, and prefs. Continue?",
                          )
                        ) {
                          if (fileRef.current) fileRef.current.value = "";
                          return;
                        }
                        setImportBusy(true);
                        setImportMsg(null);
                        try {
                          await onImport(f);
                          setImportMsg("Restored.");
                        } catch (err) {
                          setImportMsg(
                            err instanceof Error ? err.message : "Restore failed.",
                          );
                        } finally {
                          setImportBusy(false);
                          if (fileRef.current) fileRef.current.value = "";
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      onClick={() => fileRef.current?.click()}
                      disabled={importBusy}
                    >
                      {importBusy ? "Restoring…" : "Restore from file"}
                    </button>
                  </>
                )}
                {importMsg && (
                  <span className="text-xs text-slate-600">{importMsg}</span>
                )}
              </div>
            </section>
          )}
        </div>
        </div>

        <div className="flex justify-end border-t border-slate-200 px-5 py-3">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
