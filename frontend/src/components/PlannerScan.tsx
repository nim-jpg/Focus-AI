import { useRef, useState } from "react";
import {
  findTaskByShortId,
  scanPlanner,
  ScanError,
  shortIdFor,
  type ScanUpdate,
} from "@/lib/scanPlanner";
import { ocrImage } from "@/lib/ocr";
import { decodeFocus3QRs } from "@/lib/qrDecode";
import type { Task } from "@/types/task";

interface Props {
  tasks: Task[];
  onApply: (update: ResolvedUpdate) => void;
  defaultOpen?: boolean;
  onClose?: () => void;
}

export interface ResolvedUpdate extends ScanUpdate {
  taskId: string;
  taskTitle: string;
}

const ACTION_LABELS: Record<ScanUpdate["action"], string> = {
  complete: "Mark complete",
  defer: "Snooze",
  block: "Mark blocked (snooze 14d)",
  timeSpent: "Log time",
  rename: "Rename",
};

export function PlannerScan({
  tasks,
  onApply,
  defaultOpen = false,
  onClose,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedUpdate[] | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  const reset = () => {
    setBusy(null);
    setError(null);
    setResolved(null);
    setAccepted(new Set());
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleFile = async (file: File) => {
    setError(null);
    setResolved(null);
    setAccepted(new Set());
    try {
      // Run OCR and QR detection in parallel — they read the same image.
      setBusy("scanning image (text + QR)…");
      const [ocrText, qrIds] = await Promise.all([
        ocrImage(file, (status, progress) => {
          setBusy(`${status} ${Math.round(progress * 100)}%`);
        }),
        decodeFocus3QRs(file).catch(() => [] as string[]),
      ]);

      if (!ocrText && qrIds.length === 0) {
        setError("Couldn't find any readable text or QR codes in that image.");
        return;
      }

      // Map QR-decoded full task IDs to short IDs that match what's printed.
      const qrShortIds = qrIds
        .map((id) => {
          const task = tasks.find((t) => t.id === id);
          return task ? shortIdFor(task.id) : null;
        })
        .filter((s): s is string => Boolean(s));

      // Stitch QR-confirmed IDs into the text so Claude knows they're definitely
      // present, even if OCR couldn't read the printed shortId text.
      const enrichedText =
        qrShortIds.length > 0
          ? `${ocrText}\n\nQR codes confirmed on this page: ${qrShortIds.join(", ")}`
          : ocrText;

      setBusy("asking Claude what changed…");
      const updates = await scanPlanner(enrichedText, tasks);
      const mapped: ResolvedUpdate[] = updates
        .map((u) => {
          const task = findTaskByShortId(tasks, u.shortId);
          if (!task) return null;
          return { ...u, taskId: task.id, taskTitle: task.title };
        })
        .filter((u): u is ResolvedUpdate => u !== null);
      if (mapped.length === 0) {
        setError(
          "No matching task IDs found. Make sure the planner pages still show the #abc123 stamps clearly.",
        );
      } else {
        setResolved(mapped);
        // pre-select all by default
        setAccepted(new Set(mapped.map((_, i) => i)));
      }
    } catch (err) {
      const msg =
        err instanceof ScanError ? err.message : err instanceof Error ? err.message : "scan failed";
      setError(msg);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const toggleAccept = (idx: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const apply = () => {
    if (!resolved) return;
    resolved.forEach((u, idx) => {
      if (accepted.has(idx)) onApply(u);
    });
    reset();
    if (onClose) onClose();
    else setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary w-full justify-start text-slate-600"
        onClick={() => setOpen(true)}
      >
        <span className="mr-2">📥</span> Scan back a marked-up planner — apply ticks, defers, time logged
      </button>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Scan back planner</h3>
        <button
          type="button"
          className="text-xs text-slate-500 hover:text-slate-800"
          onClick={() => {
            reset();
            if (onClose) onClose();
            else setOpen(false);
          }}
        >
          Close
        </button>
      </div>

      {!resolved && (
        <>
          <p className="text-xs text-slate-600">
            Take a photo of the marked-up planner. The QR codes pin down which
            tasks were on the page; OCR reads the handwritten ticks / DEFER /
            BLOCKED notes; Claude tells you what to update.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => fileRef.current?.click()}
            disabled={Boolean(busy)}
          >
            {busy ? `Scanning… ${busy}` : "📷 Pick image"}
          </button>
          {error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {error}
            </div>
          )}
        </>
      )}

      {resolved && (
        <>
          <p className="text-xs text-slate-600">
            {accepted.size} of {resolved.length} updates selected.
          </p>
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
            {resolved.map((u, idx) => (
              <li key={`${u.taskId}-${idx}`} className="flex items-start gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={accepted.has(idx)}
                  onChange={() => toggleAccept(idx)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{u.taskTitle}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      {ACTION_LABELS[u.action]}
                    </span>
                    {u.value !== undefined && (
                      <span className="text-xs text-slate-600">→ {String(u.value)}</span>
                    )}
                  </div>
                  {u.evidence && (
                    <p className="text-xs text-slate-500">"{u.evidence}"</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={reset}>
              Discard
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={apply}
              disabled={accepted.size === 0}
            >
              Apply {accepted.size}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
