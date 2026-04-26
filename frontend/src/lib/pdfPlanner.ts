import { prioritize } from "./prioritize";
import { isFoundation } from "./recurrence";
import type { Task, UserPrefs } from "@/types/task";

const DAY_MS = 24 * 60 * 60 * 1000;
const URGENCY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function shortId(id: string): string {
  return `#${id.replace(/[^a-z0-9]/gi, "").slice(-6)}`;
}

function dueLabel(iso?: string): string {
  if (!iso) return "no due";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "no due";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Build a single A4 page weekly planner and trigger a download. */
export async function exportWeeklyPlanner(
  tasks: Task[],
  prefs: UserPrefs,
): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 28;
  const contentW = pageW - margin * 2;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * DAY_MS);

  const checkbox = (x: number, y: number, size = 9) => {
    doc.setDrawColor(60);
    doc.setLineWidth(0.6);
    doc.rect(x, y - size + 1, size, size);
  };

  // ── Header ────────────────────────────────────────────────────────────────
  let y = margin + 14;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Focus3 — Weekly Planner", margin, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `${start.toLocaleDateString()} → ${new Date(end.getTime() - 1).toLocaleDateString()}   ·   mode: ${prefs.mode}`,
    margin,
    y + 14,
  );
  doc.setTextColor(0);
  y += 32;

  // Pick up to 8 priority tasks for the week (3 key + 5 stretch).
  // Run prioritize once with the start of the week as `now` so dates land sanely.
  const top = prioritize(tasks, { prefs, limit: 8, now: start });
  const keyTasks = top.slice(0, 3).map((p) => p.task);
  const stretchTasks = top.slice(3, 8).map((p) => p.task);
  const surfacedIds = new Set([...keyTasks, ...stretchTasks].map((t) => t.id));

  // ── Section: 3 key tasks ──────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Key tasks (must do this week)", margin, y);
  y += 6;
  doc.setDrawColor(220);
  doc.line(margin, y, margin + contentW, y);
  y += 12;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  if (keyTasks.length === 0) {
    doc.setTextColor(160);
    doc.text("(nothing surfaced — add tasks in app)", margin, y);
    doc.setTextColor(0);
    y += 14;
  } else {
    for (const t of keyTasks) {
      checkbox(margin, y);
      doc.text(
        truncate(t.title, 70),
        margin + 14,
        y,
      );
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(
        `due ${dueLabel(t.dueDate)}  ·  ~${t.estimatedMinutes ?? 30}m  ·  ${t.theme}  ·  ${shortId(t.id)}`,
        margin + 14,
        y + 10,
      );
      doc.setTextColor(0);
      doc.setFontSize(10);
      // Time-spent / status line
      doc.setDrawColor(220);
      doc.line(margin + 14, y + 22, margin + contentW, y + 22);
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(
        "time:____   defer▢  blocked▢  notes:",
        margin + 14,
        y + 20,
      );
      doc.setTextColor(0);
      doc.setFontSize(10);
      y += 30;
    }
  }

  y += 4;

  // ── Section: 5 stretch tasks ─────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Stretch tasks (if time allows)", margin, y);
  y += 6;
  doc.setDrawColor(220);
  doc.line(margin, y, margin + contentW, y);
  y += 12;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  if (stretchTasks.length === 0) {
    doc.setTextColor(160);
    doc.text("(none queued)", margin, y);
    doc.setTextColor(0);
    y += 14;
  } else {
    for (const t of stretchTasks) {
      checkbox(margin, y);
      doc.text(truncate(t.title, 70), margin + 14, y);
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(
        `due ${dueLabel(t.dueDate)}  ·  ${t.theme}  ·  ${shortId(t.id)}`,
        pageW - margin - 180,
        y,
      );
      doc.setTextColor(0);
      doc.setFontSize(10);
      y += 14;
    }
  }

  y += 6;

  // ── Section: Foundations (per-day grid; counter habits get N boxes per day) ──
  const foundations = tasks.filter((t) => isFoundation(t));
  if (foundations.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Foundations — daily habits", margin, y);
    y += 6;
    doc.setDrawColor(220);
    doc.line(margin, y, margin + contentW, y);
    y += 14;

    // Day-of-week column header
    doc.setFontSize(7);
    doc.setTextColor(120);
    const dayLabels = ["M", "T", "W", "T", "F", "S", "S"];
    const labelColX = margin + 160;
    const dayColW = (contentW - 160) / 7;
    dayLabels.forEach((d, i) => {
      doc.text(d, labelColX + i * dayColW + dayColW / 2 - 2, y);
    });
    doc.setTextColor(0);
    y += 4;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);

    for (const t of foundations) {
      const isCounter = Boolean(t.counter && t.counter.target > 0);
      const target = t.counter?.target ?? 1;

      // Habit label
      doc.text(
        truncate(`${t.title}${isCounter ? ` (${target})` : ""}`, 28),
        margin,
        y + 9,
      );
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(t.timeOfDay ?? "anytime", margin, y + 18);
      doc.setTextColor(0);
      doc.setFontSize(9);

      // Day cells
      if (isCounter) {
        // Render N small boxes per day (one per glass / unit)
        const perBox = Math.min(8, Math.floor(dayColW / (target + 1)));
        for (let d = 0; d < 7; d++) {
          for (let n = 0; n < target; n++) {
            checkbox(labelColX + d * dayColW + n * (perBox + 1), y + 6, perBox);
          }
        }
        y += 18;
      } else {
        for (let d = 0; d < 7; d++) {
          checkbox(labelColX + d * dayColW + dayColW / 2 - 5, y + 6);
        }
        y += 18;
      }
    }
    y += 4;
  }

  // ── Section: Other tasks (sorted by due date, then urgency) ───────────────
  const others = tasks
    .filter(
      (t) =>
        !surfacedIds.has(t.id) &&
        !isFoundation(t) &&
        t.status !== "completed",
    )
    .sort((a, b) => {
      const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      const aU = URGENCY_RANK[a.urgency] ?? 2;
      const bU = URGENCY_RANK[b.urgency] ?? 2;
      return aU - bU;
    });

  // Reserve space for doodle box at the bottom (~150pt). Truncate "others" to fit.
  const doodleHeight = 130;
  const footerHeight = 16;
  const availableForOthers = pageH - margin - doodleHeight - footerHeight - y - 30;
  const linesAvailable = Math.max(0, Math.floor(availableForOthers / 11));
  const othersToShow = others.slice(0, linesAvailable);
  const othersOverflow = others.length - othersToShow.length;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Other tasks (by due date)", margin, y);
  y += 6;
  doc.setDrawColor(220);
  doc.line(margin, y, margin + contentW, y);
  y += 12;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  if (othersToShow.length === 0) {
    doc.setTextColor(160);
    doc.text("(no other open tasks)", margin, y);
    doc.setTextColor(0);
    y += 11;
  } else {
    for (const t of othersToShow) {
      checkbox(margin, y, 7);
      doc.text(truncate(t.title, 70), margin + 11, y);
      doc.setTextColor(120);
      doc.text(
        `${dueLabel(t.dueDate)}  ·  ${t.urgency}  ·  ${t.theme}  ·  ${shortId(t.id)}`,
        pageW - margin - 165,
        y,
      );
      doc.setTextColor(0);
      y += 11;
    }
    if (othersOverflow > 0) {
      doc.setTextColor(150);
      doc.text(`+${othersOverflow} more — see app`, margin, y);
      doc.setTextColor(0);
      y += 11;
    }
  }

  // ── Doodle / notes box ────────────────────────────────────────────────────
  const doodleY = pageH - margin - doodleHeight - footerHeight;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Notes / doodles", margin, doodleY - 4);
  doc.setFont("helvetica", "normal");

  // Dotted-grid pattern inside the box for friendly note-taking
  doc.setDrawColor(210);
  doc.setLineWidth(0.5);
  doc.rect(margin, doodleY, contentW, doodleHeight);
  doc.setFillColor(220, 220, 220);
  for (let gx = margin + 12; gx < margin + contentW - 6; gx += 12) {
    for (let gy = doodleY + 12; gy < doodleY + doodleHeight - 6; gy += 12) {
      doc.circle(gx, gy, 0.4, "F");
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(
    "Mark ✓ to complete · write 'DEFER' or 'BLOCKED' next to a task · keep #IDs intact for Scan-back to update your log.",
    margin,
    pageH - margin / 2,
  );

  const stamp = start.toISOString().slice(0, 10);
  doc.save(`Focus3-week-${stamp}.pdf`);
}
