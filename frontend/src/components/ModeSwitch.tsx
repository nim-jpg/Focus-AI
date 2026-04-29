import type { UserPrefs, UserType } from "@/types/task";
import { workLabelFor } from "@/lib/modeFilter";

interface Props {
  mode: UserPrefs["mode"];
  userType?: UserType;
  onChange: (mode: UserPrefs["mode"]) => void;
}

export function ModeSwitch({ mode, userType, onChange }: Props) {
  // The "work-bucket" label adapts to who the user is — employees see
  // "Projects" (Focus3 covers their side ventures + life, not the day job);
  // self-employed see "Work"; students see "School". The underlying mode
  // value stays "work" so persisted prefs and filter logic stay consistent.
  const workLabel = workLabelFor(userType);
  const options: Array<{ value: UserPrefs["mode"]; label: string }> = [
    { value: "both", label: "Both" },
    { value: "work", label: workLabel },
    { value: "personal", label: "Personal" },
  ];
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm shadow-sm">
      {options.map((opt) => (
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
