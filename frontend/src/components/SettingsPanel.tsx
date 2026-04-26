import { useEffect, useRef, useState } from "react";
import type { UserPrefs } from "@/types/task";
import { TimeField } from "./TimeField";

interface Props {
  prefs: UserPrefs;
  onChange: (patch: Partial<UserPrefs>) => void;
  onClose: () => void;
  /** Optional backup hooks; when omitted the section is hidden. */
  onExport?: () => void;
  onImport?: (file: File) => Promise<void>;
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
}: Props) {
  const [permState, setPermState] = useState<NotificationPermission | null>(
    typeof Notification !== "undefined" ? Notification.permission : null,
  );
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">Settings</h3>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-900"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="space-y-5">
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

        <div className="mt-5 flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
