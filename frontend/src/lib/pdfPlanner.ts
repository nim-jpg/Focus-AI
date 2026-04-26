import { prioritize } from "./prioritize";
import { isDueNow, isFoundation } from "./recurrence";
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
 * The PDF is a personal printout — show every task title in full. The privacy
 * field is reserved for future share/export flows where redaction matters.
 */
function renderTitle(task: Task): string {
  return task.title;
}

function shortId(id: string): string {
  return `#${id.replace(/[^a-z0-9]/gi, "").slice(-6)}`;
}

/** Build a one-week planner PDF and trigger a download. */
export async function exportWeeklyPlanner(
  tasks: Task[],
  prefs: UserPrefs,
): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 36;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * DAY_MS);

  const foundations = tasks.filter((t) => isFoundation(t));

  // Helper to draw an unfilled checkbox.
  const checkbox = (x: number, y: number, size = 9) => {
    doc.setDrawColor(60);
    doc.setLineWidth(0.7);
    doc.rect(x, y - size + 1, size, size);
  };

  // ── Cover page: this week at a glance ─────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("Focus3 — Weekly Planner", margin, margin + 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    `${start.toLocaleDateString()} → ${new Date(end.getTime() - 1).toLocaleDateString()}  ·  mode: ${prefs.mode}`,
    margin,
    margin + 28,
  );
  doc.setTextColor(0);

  // Foundations strip
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Daily Foundations", margin, margin + 56);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);

  let yCursor = margin + 72;
  if (foundations.length === 0) {
    doc.setTextColor(140);
    doc.text("(none — add daily habits in app)", margin, yCursor);
    doc.setTextColor(0);
    yCursor += 14;
  } else {
    foundations.forEach((t) => {
      const title = renderTitle(t);
      if (!title) return;
      // 7 boxes for the week + label
      for (let i = 0; i < 7; i++) {
        checkbox(margin + i * 14, yCursor);
      }
      const slot = t.timeOfDay ?? "anytime";
      doc.text(
        `  ${title}${t.counter ? ` (target ${t.counter.target})` : ""} — ${slot}`,
        margin + 7 * 14 + 4,
        yCursor,
      );
      doc.setFontSize(8);
      doc.setTextColor(160);
      doc.text(shortId(t.id), pageW - margin - 40, yCursor);
      doc.setTextColor(0);
      doc.setFontSize(10);
      yCursor += 14;
    });
  }

  // Day labels above the foundations row
  doc.setFontSize(7);
  doc.setTextColor(120);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    doc.text(d.toLocaleDateString(undefined, { weekday: "narrow" }), margin + i * 14 + 1, margin + 68);
  }
  doc.setTextColor(0);
  doc.setFontSize(10);

  doc.addPage();

  // ── Per-day pages ─────────────────────────────────────────────────────────
  for (let i = 0; i < 7; i++) {
    if (i > 0) doc.addPage();
    const date = new Date(start.getTime() + i * DAY_MS);
    const top = prioritize(tasks, { prefs, limit: 3, now: date });

    // weekly+ tasks that become due during this calendar day (not in Top 3 already)
    const topIds = new Set(top.map((p) => p.task.id));
    const weeklyDue = tasks.filter((t) => {
      if (topIds.has(t.id)) return false;
      if (t.status === "completed") return false;
      if (t.recurrence === "none" || t.recurrence === "daily") return false;
      return isDueNow(t, date);
    });

    let y = margin + 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(dayLabel(date), margin, y);
    y += 24;

    // Top Three
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Top Three", margin, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    if (top.length === 0) {
      doc.setTextColor(160);
      doc.text("(nothing surfaced)", margin, y);
      doc.setTextColor(0);
      y += 16;
    } else {
      top.forEach((p, idx) => {
        const title = renderTitle(p.task);
        if (!title) return;
        checkbox(margin, y);
        doc.text(
          `${idx + 1}. ${title}  ·  Tier ${p.tier}  ·  ~${p.task.estimatedMinutes ?? 30}m`,
          margin + 16,
          y,
        );
        doc.setFontSize(8);
        doc.setTextColor(160);
        doc.text(shortId(p.task.id), pageW - margin - 40, y);
        doc.setTextColor(0);
        doc.setFontSize(10);
        y += 14;
        // Time spent / status line
        doc.setFontSize(8);
        doc.setTextColor(120);
        doc.text(
          "Time spent: ____   Defer ▢   Blocked ▢   Notes:",
          margin + 16,
          y,
        );
        doc.setTextColor(0);
        doc.setFontSize(10);
        y += 16;
      });
    }

    // Foundations for the day
    if (foundations.length > 0) {
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text("Foundations", margin, y);
      y += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      foundations.forEach((t) => {
        const title = renderTitle(t);
        if (!title) return;
        checkbox(margin, y);
        const counterTag = t.counter
          ? `   tally: ▢▢▢▢▢▢▢▢ (target ${t.counter.target})`
          : "";
        doc.text(
          `${title} — ${t.timeOfDay ?? "anytime"}${counterTag}`,
          margin + 16,
          y,
        );
        doc.setFontSize(8);
        doc.setTextColor(160);
        doc.text(shortId(t.id), pageW - margin - 40, y);
        doc.setTextColor(0);
        doc.setFontSize(10);
        y += 14;
      });
    }

    // Weekly+ tasks due that day
    if (weeklyDue.length > 0) {
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text("Weekly / monthly due", margin, y);
      y += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      weeklyDue.forEach((t) => {
        const title = renderTitle(t);
        if (!title) return;
        checkbox(margin, y);
        doc.text(
          `${title}  ·  ${t.recurrence}  ·  ~${t.estimatedMinutes ?? 30}m`,
          margin + 16,
          y,
        );
        doc.setFontSize(8);
        doc.setTextColor(160);
        doc.text(shortId(t.id), pageW - margin - 40, y);
        doc.setTextColor(0);
        doc.setFontSize(10);
        y += 14;
      });
    }
  }

  // Footer on each page
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(160);
    doc.text(
      "Mark ✓ to complete · write 'DEFER' or 'BLOCKED' next to a task · keep IDs intact for the Scan-back to update your log.",
      margin,
      pageH - 20,
    );
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin - 60, pageH - 20);
  }

  const stamp = start.toISOString().slice(0, 10);
  doc.save(`Focus3-week-${stamp}.pdf`);
}
