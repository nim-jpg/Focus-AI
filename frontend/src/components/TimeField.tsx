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

  // Each unit (hour, minute) is a stacked column: ▴ above, number, ▾ below.
  // Buttons sized to a comfortable click target (≥24px wide) without making
  // the field huge.
  const Unit = ({
    val,
    onUp,
    onDown,
    onType,
    label,
  }: {
    val: number;
    onUp: () => void;
    onDown: () => void;
    onType: (n: number) => void;
    label: string;
  }) => (
    <div className="flex flex-col items-center">
      <button
        type="button"
        className="flex h-5 w-7 items-center justify-center rounded text-xs leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        onClick={onUp}
        aria-label={`${label} +`}
      >
        ▴
      </button>
      <input
        type="text"
        inputMode="numeric"
        maxLength={2}
        className="w-7 border-0 bg-transparent p-0 text-center font-mono text-sm focus:outline-none focus:ring-0"
        value={pad(val)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onType(n);
        }}
        aria-label={label}
      />
      <button
        type="button"
        className="flex h-5 w-7 items-center justify-center rounded text-xs leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        onClick={onDown}
        aria-label={`${label} −`}
      >
        ▾
      </button>
    </div>
  );

  return (
    <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1">
      <Unit
        val={h}
        label="Hour"
        onUp={() => set(h + 1, m)}
        onDown={() => set(h - 1, m)}
        onType={(n) => set(n, m)}
      />
      <span className="px-0.5 font-mono text-sm text-slate-400">:</span>
      <Unit
        val={m}
        label="Minute"
        onUp={() => set(h, m + minuteStep)}
        onDown={() => set(h, m - minuteStep)}
        onType={(n) => set(h, n)}
      />
      {allowEmpty && value && (
        <button
          type="button"
          className="ml-1 flex h-5 w-5 items-center justify-center rounded text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
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
