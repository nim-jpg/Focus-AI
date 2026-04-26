import { prioritize } from "./prioritize";
import type { Task, UserPrefs } from "@/types/task";

const DAY_MS = 24 * 60 * 60 * 1000;

function dayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/**
 * Strip a task title for PDF rendering. Private tasks never appear; semi-private
 * are redacted to "[private commitment]" so the slot stays visible without
 * leaking the title.
 */
function renderTitle(task: Task): string | null {
  if (task.privacy === "private") return null;
  if (task.privacy === "semi-private") return "[private commitment]";
  return task.title;
}

/** Build a 7-day Top-Three planner PDF and trigger a download. */
export async function exportWeeklyPlanner(
  tasks: Task[],
  prefs: UserPrefs,
): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("Focus3 — Weekly Planner", margin, margin + 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    `Generated ${start.toLocaleDateString()} · mode: ${prefs.mode}`,
    margin,
    margin + 28,
  );
  doc.setTextColor(0);

  const dayBoxH = (pageH - margin * 2 - 60) / 7;
  let y = margin + 50;

  for (let i = 0; i < 7; i++) {
    const date = new Date(start.getTime() + i * DAY_MS);
    const top = prioritize(tasks, { prefs, limit: 3, now: date });

    doc.setDrawColor(220);
    doc.line(margin, y, margin + contentW, y);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(dayLabel(date), margin, y + 18);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    if (top.length === 0) {
      doc.setTextColor(160);
      doc.text("(nothing surfaced)", margin + 140, y + 18);
      doc.setTextColor(0);
    } else {
      const items = top
        .map((p, idx) => {
          const title = renderTitle(p.task);
          if (!title) return null;
          const mins = p.task.estimatedMinutes ?? 30;
          return `${idx + 1}. ${title}  ·  ${mins}m  ·  Tier ${p.tier}`;
        })
        .filter((s): s is string => Boolean(s));

      items.forEach((line, idx) => {
        doc.text(line, margin + 140, y + 18 + idx * 14);
      });
    }

    y += dayBoxH;
  }

  doc.setFontSize(8);
  doc.setTextColor(160);
  doc.text(
    "Private tasks omitted. Semi-private tasks redacted.",
    margin,
    pageH - margin / 2,
  );

  const stamp = start.toISOString().slice(0, 10);
  doc.save(`Focus3-week-${stamp}.pdf`);
}
