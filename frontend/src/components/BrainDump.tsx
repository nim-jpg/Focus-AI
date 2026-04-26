import { useRef, useState } from "react";
import { parseBrainDump, ParseUnavailableError } from "@/lib/parseTasks";
import { ocrImage } from "@/lib/ocr";
import type { NewTaskInput } from "@/lib/useTasks";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  onAdd: (task: NewTaskInput) => void;
  /** When true, the form is open from mount and the toggle button is hidden. */
  defaultOpen?: boolean;
  /** Called when the close button is hit. If not provided, falls back to internal toggle. */
  onClose?: () => void;
}

interface Suggestion extends NewTaskInput {
  _key: string;
  _selected: boolean;
}

const PLACEHOLDER = `Paste anything — a todo list, a meeting note, an email.

e.g.
- take vitamin D every morning
- file Q1 tax return by EOM, takes ~2 hours
- run 3x this week
- email landlord about boiler — they said next Tuesday
- finish the React migration so QA can start testing`;

export function BrainDump({ onAdd, defaultOpen = false, onClose }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setText("");
    setSuggestions(null);
    setError(null);
    setOcrStatus(null);
  };

  const handleScan = async (file: File) => {
    setLoading(true);
    setError(null);
    setOcrStatus("loading worker…");
    try {
      const recognised = await ocrImage(file, (status, progress) => {
        setOcrStatus(`${status} ${Math.round(progress * 100)}%`);
      });
      if (!recognised) {
        setError("OCR didn't find any text in that image.");
      } else {
        // Append so the user can scan multiple pages into one parse.
        setText((prev) => (prev ? `${prev}\n\n${recognised}` : recognised));
      }
    } catch (err) {
      setError(`Scan failed — ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
      setOcrStatus(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleParse = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const parsed = await parseBrainDump(text);
      if (parsed.length === 0) {
        setError("Claude didn't find any tasks in that text.");
        return;
      }
      setSuggestions(
        parsed.map((task, i) => ({
          ...task,
          _key: `${Date.now()}-${i}`,
          _selected: true,
        })),
      );
    } catch (err) {
      const reason =
        err instanceof ParseUnavailableError ? err.message : "unexpected error";
      setError(`Couldn't parse — ${reason}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (key: string) => {
    setSuggestions((prev) =>
      prev
        ? prev.map((s) => (s._key === key ? { ...s, _selected: !s._selected } : s))
        : prev,
    );
  };

  const setAllSelected = (value: boolean) => {
    setSuggestions((prev) =>
      prev ? prev.map((s) => ({ ...s, _selected: value })) : prev,
    );
  };

  const handleConfirm = () => {
    if (!suggestions) return;
    const accepted = suggestions.filter((s) => s._selected);
    for (const { _key, _selected, ...task } of accepted) {
      void _key;
      void _selected;
      onAdd(task);
    }
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
        <span className="mr-2">✨</span> Brain dump — paste a list, let Claude
        sort it
      </button>
    );
  }

  const selectedCount = suggestions?.filter((s) => s._selected).length ?? 0;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Brain dump</h3>
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

      {!suggestions && (
        <>
          <textarea
            className="input min-h-[160px] font-mono text-xs"
            placeholder={PLACEHOLDER}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
          />
          {ocrStatus && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              Scanning… {ocrStatus}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {error}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleScan(file);
                }}
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => fileRef.current?.click()}
                disabled={loading}
                title="Scan a photo of handwritten or printed notes"
              >
                📷 Scan image
              </button>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={reset}
                disabled={loading || !text}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleParse}
                disabled={loading || !text.trim()}
              >
                {loading && !ocrStatus ? "Parsing…" : "Parse with Claude"}
              </button>
            </div>
          </div>
        </>
      )}

      {suggestions && (
        <>
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              {selectedCount} of {suggestions.length} selected
            </span>
            <div className="flex gap-3">
              <button
                type="button"
                className="hover:text-slate-900"
                onClick={() => setAllSelected(true)}
              >
                Select all
              </button>
              <button
                type="button"
                className="hover:text-slate-900"
                onClick={() => setAllSelected(false)}
              >
                Select none
              </button>
            </div>
          </div>

          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
            {suggestions.map((s) => (
              <li
                key={s._key}
                className="flex items-start gap-3 px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={s._selected}
                  onChange={() => toggleSelect(s._key)}
                  aria-label={`Include ${s.title}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`font-medium ${
                        s._selected ? "" : "text-slate-400 line-through"
                      }`}
                    >
                      {s.title}
                    </span>
                    <ThemeBadge theme={s.theme} />
                    {s.recurrence !== "none" && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {s.recurrence}
                      </span>
                    )}
                    {s.urgency !== "normal" && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {s.urgency}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    {s.dueDate
                      ? `due ${new Date(s.dueDate).toLocaleDateString()}`
                      : "no deadline"}{" "}
                    · {s.estimatedMinutes ?? 30} min · {s.privacy}
                  </p>
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
              onClick={handleConfirm}
              disabled={selectedCount === 0}
            >
              Add {selectedCount} task{selectedCount === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
