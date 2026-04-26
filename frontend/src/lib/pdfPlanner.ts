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

/** Generate a small QR data URI encoding the task id for camera scan-back. */
async function qrFor(taskId: string): Promise<string | null> {
  try {
    const QR = await import("qrcode");
    return await QR.toDataURL(`focus3:${taskId}`, {
      margin: 0,
      width: 120,
      errorCorrectionLevel: "M",
    });
  } catch {
    return null;
  }
}

/**
 * Pick "key tasks" for the week:
 *  1. Tasks with a due date in the next 7 days, sorted by deadline
 *  2. If fewer than 3, top up from prioritize() (excluding daily-recurring)
 * Returns up to 3.
 */
function pickKeyTasks(
  tasks: Task[],
  prefs: UserPrefs,
  weekStart: Date,
  weekEnd: Date,
): Task[] {
  const inWeek = tasks
    .filter((t) => {
      if (t.status === "completed") return false;
      if (isFoundation(t)) return false;
      if (t.recurrence === "daily") return false;
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate).getTime();
      return d >= weekStart.getTime() && d < weekEnd.getTime();
    })
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());

  const key: Task[] = inWeek.slice(0, 3);
  if (key.length < 3) {
    const seen = new Set(key.map((t) => t.id));
    const filler = prioritize(tasks, { prefs, limit: 8, now: weekStart })
      .map((p) => p.task)
      .filter(
        (t) => !seen.has(t.id) && t.recurrence !== "daily" && !isFoundation(t),
      );
    for (const t of filler) {
      key.push(t);
      if (key.length >= 3) break;
    }
  }
  return key;
}

function pickStretchTasks(
  tasks: Task[],
  prefs: UserPrefs,
  weekStart: Date,
  excludeIds: Set<string>,
): Task[] {
  const candidates = prioritize(tasks, { prefs, limit: 16, now: weekStart })
    .map((p) => p.task)
    .filter(
      (t) =>
        !excludeIds.has(t.id) &&
        t.recurrence !== "daily" &&
        !isFoundation(t),
    );
  return candidates.slice(0, 5);
}

/** Single-page A4 landscape weekly planner. */
export async function exportWeeklyPlanner(
  tasks: Task[],
  prefs: UserPrefs,
): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 28;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * DAY_MS);

  // Two-column layout
  const colGap = 24;
  const colW = (pageW - margin * 2 - colGap) / 2;
  const leftX = margin;
  const rightX = margin + colW + colGap;

  const checkbox = (x: number, y: number, size = 10) => {
    doc.setDrawColor(80);
    doc.setLineWidth(0.7);
    doc.rect(x, y - size + 1, size, size);
  };

  // Embed a small QR for camera-friendly scan-back. Always print the short
  // text ID below it as a fallback for the OCR-based scan path.
  const drawQR = async (taskId: string, x: number, y: number, size = 24) => {
    const data = await qrFor(taskId);
    if (data) doc.addImage(data, "PNG", x, y, size, size);
    doc.setFontSize(6);
    doc.setTextColor(160);
    doc.text(shortId(taskId), x, y + size + 6);
    doc.setTextColor(0);
  };

  // ── Header ────────────────────────────────────────────────────────────────
  let y = margin + 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Focus3 — Weekly Planner", margin, y + 6);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `${start.toLocaleDateString()} → ${new Date(end.getTime() - 1).toLocaleDateString()}   ·   mode: ${prefs.mode}`,
    margin + 230,
    y + 6,
  );
  doc.setTextColor(0);
  y += 24;

  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 16;

  // Build content for each task list
  const keyTasks = pickKeyTasks(tasks, prefs, start, end);
  const keyIds = new Set(keyTasks.map((t) => t.id));
  const stretchTasks = pickStretchTasks(tasks, prefs, start, keyIds);
  const stretchIds = new Set(stretchTasks.map((t) => t.id));
  const surfacedIds = new Set([...keyIds, ...stretchIds]);

  // ── LEFT COLUMN ───────────────────────────────────────────────────────────
  let leftY = y;

  // Section: Key tasks
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Key tasks — must do this week", leftX, leftY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text("due this week or top priority", leftX + 180, leftY);
  doc.setTextColor(0);
  leftY += 4;
  doc.setDrawColor(220);
  doc.line(leftX, leftY, leftX + colW, leftY);
  leftY += 14;

  if (keyTasks.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(160);
    doc.text("(nothing surfaced)", leftX, leftY);
    doc.setTextColor(0);
    leftY += 16;
  } else {
    for (const t of keyTasks) {
      checkbox(leftX, leftY);
      doc.setFontSize(10);
      doc.text(truncate(t.title, 60), leftX + 16, leftY);

      doc.setFontSize(7);
      doc.setTextColor(120);
      doc.text(
        `due ${dueLabel(t.dueDate)}  ·  ~${t.estimatedMinutes ?? 30}m  ·  ${t.theme}`,
        leftX + 16,
        leftY + 10,
      );
      doc.setTextColor(0);

      // QR on the right edge
      await drawQR(t.id, leftX + colW - 30, leftY - 8, 26);

      // Time/defer/notes line
      doc.setDrawColor(220);
      doc.line(leftX + 16, leftY + 22, leftX + colW - 36, leftY + 22);
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(
        "time spent: ____    defer ▢    blocked ▢    notes:",
        leftX + 16,
        leftY + 20,
      );
      doc.setTextColor(0);

      leftY += 36;
    }
  }

  leftY += 6;

  // Section: Stretch tasks
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Stretch tasks — if time allows", leftX, leftY);
  leftY += 4;
  doc.setDrawColor(220);
  doc.line(leftX, leftY, leftX + colW, leftY);
  leftY += 14;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  if (stretchTasks.length === 0) {
    doc.setTextColor(160);
    doc.text("(none queued)", leftX, leftY);
    doc.setTextColor(0);
    leftY += 14;
  } else {
    for (const t of stretchTasks) {
      checkbox(leftX, leftY, 9);
      doc.text(truncate(t.title, 50), leftX + 14, leftY);
      doc.setFontSize(7);
      doc.setTextColor(120);
      doc.text(
        `${dueLabel(t.dueDate)}  ·  ${t.theme}`,
        leftX + colW - 130,
        leftY,
      );
      doc.setTextColor(0);
      await drawQR(t.id, leftX + colW - 24, leftY - 8, 18);
      doc.setFontSize(9);
      leftY += 18;
    }
  }

  leftY += 6;

  // Section: Other tasks (backlog)
  const others = tasks
    .filter(
      (t) =>
        !surfacedIds.has(t.id) &&
        !isFoundation(t) &&
        t.recurrence !== "daily" &&
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

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Backlog — other tasks by due date", leftX, leftY);
  leftY += 4;
  doc.setDrawColor(220);
  doc.line(leftX, leftY, leftX + colW, leftY);
  leftY += 12;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  // Truncate to fit the left column.
  const maxOthersY = pageH - margin - 12;
  for (const t of others) {
    if (leftY > maxOthersY - 11) {
      doc.setTextColor(150);
      doc.text(
        `+${others.length - others.indexOf(t)} more — see app`,
        leftX,
        leftY,
      );
      doc.setTextColor(0);
      break;
    }
    checkbox(leftX, leftY, 7);
    doc.text(truncate(t.title, 56), leftX + 12, leftY);
    doc.setTextColor(120);
    doc.text(
      `${dueLabel(t.dueDate)}  ·  ${t.urgency}  ·  ${t.theme}  ·  ${shortId(t.id)}`,
      leftX + colW - 170,
      leftY,
    );
    doc.setTextColor(0);
    leftY += 11;
  }

  // ── RIGHT COLUMN ──────────────────────────────────────────────────────────
  let rightY = y;

  // Section: Daily habits — ALL daily-recurring tasks (not just isFoundation)
  const dailyTasks = tasks.filter(
    (t) => t.recurrence === "daily" && t.status !== "completed",
  );

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Daily habits", rightX, rightY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text("tick a box for each day done", rightX + 80, rightY);
  doc.setTextColor(0);
  rightY += 4;
  doc.setDrawColor(220);
  doc.line(rightX, rightY, rightX + colW, rightY);
  rightY += 14;

  // Day-of-week header row
  const labelW = 130;
  const dayColW = (colW - labelW) / 7;
  doc.setFontSize(7);
  doc.setTextColor(120);
  ["M", "T", "W", "T", "F", "S", "S"].forEach((d, i) => {
    doc.text(d, rightX + labelW + i * dayColW + dayColW / 2 - 2, rightY);
  });
  doc.setTextColor(0);
  rightY += 4;

  if (dailyTasks.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(160);
    doc.text("(no daily habits set)", rightX, rightY + 8);
    doc.setTextColor(0);
    rightY += 24;
  } else {
    doc.setFont("helvetica", "normal");
    for (const t of dailyTasks) {
      const isCounter = Boolean(t.counter && t.counter.target > 0);
      const target = t.counter?.target ?? 1;
      const rowH = isCounter ? 24 : 18;

      doc.setFontSize(9);
      doc.text(truncate(t.title, 22), rightX, rightY + 9);
      doc.setFontSize(7);
      doc.setTextColor(150);
      const meta = [
        t.timeOfDay ?? "anytime",
        isCounter ? `target ${target}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      doc.text(meta, rightX, rightY + 18);
      doc.setTextColor(0);

      if (isCounter) {
        // Render N small boxes per day
        const perBox = Math.max(4, Math.min(7, Math.floor(dayColW / (target + 1))));
        for (let d = 0; d < 7; d++) {
          for (let n = 0; n < target; n++) {
            checkbox(
              rightX + labelW + d * dayColW + n * (perBox + 1),
              rightY + 12,
              perBox,
            );
          }
        }
      } else {
        for (let d = 0; d < 7; d++) {
          checkbox(rightX + labelW + d * dayColW + dayColW / 2 - 5, rightY + 9, 9);
        }
      }
      rightY += rowH;
    }
  }

  rightY += 8;

  // Section: Notes / doodles — fills the rest of the right column
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Notes / doodles", rightX, rightY);
  rightY += 4;
  doc.setDrawColor(220);
  doc.line(rightX, rightY, rightX + colW, rightY);
  rightY += 8;

  const doodleY = rightY;
  const doodleH = pageH - margin - doodleY - 12;
  doc.setDrawColor(210);
  doc.setLineWidth(0.5);
  doc.rect(rightX, doodleY, colW, doodleH);
  doc.setFillColor(220, 220, 220);
  for (let gx = rightX + 12; gx < rightX + colW - 6; gx += 14) {
    for (let gy = doodleY + 12; gy < doodleY + doodleH - 6; gy += 14) {
      doc.circle(gx, gy, 0.35, "F");
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(
    "Mark ✓ to complete · write 'DEFER' or 'BLOCKED' next to a task · keep the QR codes intact for camera-friendly scan-back.",
    margin,
    pageH - 8,
  );

  const stamp = start.toISOString().slice(0, 10);
  doc.save(`Focus3-week-${stamp}.pdf`);
}
