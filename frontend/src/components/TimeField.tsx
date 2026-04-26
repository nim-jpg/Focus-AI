interface Props {
  /** "HH:MM" or empty string for unset. */
  value: string;
  onChange: (next: string) => void;
  /** Minute increment per arrow click. Default 5. */
  minuteStep?: number;
  /** Allow empty/clear when true. */
  allowEmpty?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function format(h: number, m: number): string {
  return `${pad(((h % 24) + 24) % 24)}:${pad(((m % 60) + 60) % 60)}`;
}

export function TimeField({
  value,
  onChange,
  minuteStep = 5,
  allowEmpty = false,
}: Props) {
  const parts = value ? value.split(":").map(Number) : [9, 0];
  const h = Number.isFinite(parts[0]) ? parts[0]! : 9;
  const m = Number.isFinite(parts[1]) ? parts[1]! : 0;

  const set = (nh: number, nm: number) => onChange(format(nh, nm));

  return (
    <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-1 text-sm">
      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
        onClick={() => set(h - 1, m)}
        aria-label="Hour −"
      >
        ▾
      </button>
      <input
        type="text"
        inputMode="numeric"
        maxLength={2}
        className="w-7 border-0 bg-transparent p-0 text-center font-mono focus:outline-none focus:ring-0"
        value={pad(h)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) set(n, m);
        }}
        aria-label="Hour"
      />
      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
        onClick={() => set(h + 1, m)}
        aria-label="Hour +"
      >
        ▴
      </button>

      <span className="px-0.5 text-slate-400">:</span>

      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
        onClick={() => set(h, m - minuteStep)}
        aria-label="Minute −"
      >
        ▾
      </button>
      <input
        type="text"
        inputMode="numeric"
        maxLength={2}
        className="w-7 border-0 bg-transparent p-0 text-center font-mono focus:outline-none focus:ring-0"
        value={pad(m)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) set(h, n);
        }}
        aria-label="Minute"
      />
      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
        onClick={() => set(h, m + minuteStep)}
        aria-label="Minute +"
      >
        ▴
      </button>

      {allowEmpty && value && (
        <button
          type="button"
          className="ml-1 rounded px-1.5 py-0.5 text-xs text-slate-400 hover:text-red-600"
          onClick={() => onChange("")}
          aria-label="Clear time"
          title="Clear"
        >
          ×
        </button>
      )}
    </div>
  );
}
