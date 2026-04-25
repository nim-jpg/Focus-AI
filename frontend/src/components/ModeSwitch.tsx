import type { UserPrefs } from "@/types/task";

interface Props {
  mode: UserPrefs["mode"];
  onChange: (mode: UserPrefs["mode"]) => void;
}

const OPTIONS: Array<{ value: UserPrefs["mode"]; label: string }> = [
  { value: "both", label: "Both" },
  { value: "work", label: "Work" },
  { value: "personal", label: "Personal" },
];

export function ModeSwitch({ mode, onChange }: Props) {
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm shadow-sm">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded px-3 py-1 transition-colors ${
            mode === opt.value
              ? "bg-slate-900 text-white"
              : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
