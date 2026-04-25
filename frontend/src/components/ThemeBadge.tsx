import type { Theme } from "@/types/task";

const LABELS: Record<Theme, string> = {
  work: "Work",
  personal: "Personal",
  fitness: "Fitness",
  finance: "Finance",
  diet: "Diet",
  medication: "Medication",
  development: "Development",
  household: "Household",
};

const CLASSES: Record<Theme, string> = {
  work: "bg-blue-100 text-blue-800",
  personal: "bg-purple-100 text-purple-800",
  fitness: "bg-green-100 text-green-800",
  finance: "bg-yellow-100 text-yellow-800",
  diet: "bg-orange-100 text-orange-800",
  medication: "bg-red-100 text-red-800",
  development: "bg-teal-100 text-teal-800",
  household: "bg-slate-200 text-slate-800",
};

export function ThemeBadge({ theme }: { theme: Theme }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CLASSES[theme]}`}
    >
      {LABELS[theme]}
    </span>
  );
}
