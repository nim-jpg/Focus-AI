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

/**
 * Deterministic FNV-style hash → array of n integers. Same task id always
 * produces the same wave code, so a printed planner stays scannable.
 */
function hashSeq(s: string, n: number): number[] {
  const out: number[] = [];
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  for (let i = 0; i < n; i++) {
    h = (h ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    out.push(h);
  }
  return out;
}

/**
 * Pick "key tasks" for the week:
 *  1. Tasks with a due date in the next 7 days, sorted by deadline
 *  2. If fewer than 3, top up from prioritize() (excluding daily-recurring)
 * Returns up to 3.
 */
/**
 * Eligible for Key / Stretch lists: significant items that move things forward.
 * - one-off (recurrence: none) is always eligible
 * - yearly + quarterly are eligible (annual filings, VAT)
 * - monthly is eligible only when urgency is critical
 * - weekly + daily are excluded (those live in the Daily habits grid)
 * - foundations and snoozed tasks are excluded
 */
function isSignificantWorkItem(t: Task): boolean {
  if (t.status === "completed") return false;
  if (isFoundation(t)) return false;
  if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) return false;
  switch (t.recurrence) {
    case "none":
    case "yearly":
    case "quarterly":
      return true;
    case "monthly":
      return t.urgency === "critical";
    case "weekly":
    case "daily":
      return false;
    default:
      return false;
  }
}

function pickKeyTasks(
  tasks: Task[],
  prefs: UserPrefs,
  weekStart: Date,
  weekEnd: Date,
): Task[] {
  const eligible = tasks.filter(isSignificantWorkItem);

  const inWeek = eligible
    .filter((t) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate).getTime();
      return d >= weekStart.getTime() && d < weekEnd.getTime();
    })
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());

  const key: Task[] = inWeek.slice(0, 3);
  if (key.length < 3) {
    const seen = new Set(key.map((t) => t.id));
    const filler = prioritize(tasks, { prefs, limit: 16, now: weekStart })
      .map((p) => p.task)
      .filter((t) => !seen.has(t.id) && isSignificantWorkItem(t));
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
  const candidates = prioritize(tasks, { prefs, limit: 24, now: weekStart })
    .map((p) => p.task)
    .filter((t) => !excludeIds.has(t.id) && isSignificantWorkItem(t));
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

  // ── Code stamp ───────────────────────────────────────────────────────────
  // Each task gets a small QR (machine-readable) + a Spotify-style wave bar
  // (visual brand) + the shortId text (OCR fallback). Right-aligned in lists.
  const QR_SIZE = 14;
  const WAVE_W = 70;
  const WAVE_H = 12;
  const WAVE_BARS = 20;
  const GAP = 4;
  // Combined bounding box: QR | gap | wave
  const CODE_W = QR_SIZE + GAP + WAVE_W;

  // Generate a small QR for the task id encoded as `focus3:<id>`. Cached so
  // we don't regenerate the same image when a task appears in multiple lists.
  const qrCache = new Map<string, string>();
  const qrFor = async (taskId: string): Promise<string | null> => {
    if (qrCache.has(taskId)) return qrCache.get(taskId)!;
    try {
      const QR = await import("qrcode");
      const dataUri = await QR.toDataURL(`focus3:${taskId}`, {
        margin: 0,
        width: 100,
        errorCorrectionLevel: "M",
      });
      qrCache.set(taskId, dataUri);
      return dataUri;
    } catch {
      return null;
    }
  };

  const drawCodes = async (taskId: string, x: number, y: number) => {
    // QR on the left
    const qrData = await qrFor(taskId);
    if (qrData) doc.addImage(qrData, "PNG", x, y, QR_SIZE, QR_SIZE);

    // Wave to the right of the QR
    const waveX = x + QR_SIZE + GAP;
    const waveY = y + (QR_SIZE - WAVE_H) / 2; // vertically centre against the QR
    const seq = hashSeq(taskId, WAVE_BARS);
    doc.setFillColor(60, 60, 60);
    doc.circle(waveX + 3, waveY + WAVE_H / 2, 1.6, "F");
    const barAreaX = waveX + 8;
    const barAreaW = WAVE_W - 8;
    const barW = (barAreaW - (WAVE_BARS - 1) * 1) / WAVE_BARS;
    for (let i = 0; i < WAVE_BARS; i++) {
      const tier = seq[i] % 3;
      const bh = WAVE_H * (0.35 + tier * 0.32);
      const bx = barAreaX + i * (barW + 1);
      const by = waveY + (WAVE_H - bh);
      doc.rect(bx, by, barW, bh, "F");
    }

    // shortId text under the whole stamp (OCR scan-back fallback)
    doc.setFontSize(5.5);
    doc.setTextColor(170);
    doc.text(shortId(taskId), x, y + QR_SIZE + 6);
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

  // Wave codes line up on the right edge for a clean column.
  const leftCodeX = leftX + colW - CODE_W;

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
      doc.text(truncate(t.title, 50), leftX + 16, leftY);

      doc.setFontSize(7);
      doc.setTextColor(120);
      doc.text(
        `due ${dueLabel(t.dueDate)}  ·  ~${t.estimatedMinutes ?? 30}m  ·  ${t.theme}`,
        leftX + 16,
        leftY + 10,
      );
      doc.setTextColor(0);

      // Wave code, right-aligned
      await drawCodes(t.id, leftCodeX, leftY - 4);

      // Time/defer/notes line — kept short so it doesn't overlap the code
      doc.setDrawColor(220);
      doc.line(leftX + 16, leftY + 22, leftCodeX - 8, leftY + 22);
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
      doc.text(truncate(t.title, 42), leftX + 14, leftY);
      doc.setFontSize(7);
      doc.setTextColor(120);
      doc.text(
        `${dueLabel(t.dueDate)}  ·  ${t.theme}`,
        leftCodeX - 80,
        leftY,
      );
      doc.setTextColor(0);
      await drawCodes(t.id, leftCodeX, leftY - 4);
      doc.setFontSize(9);
      leftY += 22;
    }
  }

  // (Backlog moved to right column under Daily habits)
  // Pre-compute the others list — it's rendered later in the right column.
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

  // ── RIGHT COLUMN ──────────────────────────────────────────────────────────
  let rightY = y;

  // Section: Daily habits — ALL daily-recurring tasks (not just isFoundation).
  // Sort: timed habits first (chronologically), then anytime.
  const dailyTasks = tasks
    .filter((t) => t.recurrence === "daily" && t.status !== "completed")
    .sort((a, b) => {
      const aT = a.specificTime ?? "99:99";
      const bT = b.specificTime ?? "99:99";
      return aT.localeCompare(bT);
    });

  // ── Daily habits ──────────────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Daily habits", rightX, rightY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text("tick each day · counters: tick one block per glass / set", rightX + 75, rightY);
  doc.setTextColor(0);
  rightY += 6;
  doc.setDrawColor(220);
  doc.line(rightX, rightY, rightX + colW, rightY);
  rightY += 18;

  // Day-of-week header row
  const labelW = 140;
  const dayColW = (colW - labelW) / 7;
  doc.setFontSize(8);
  doc.setTextColor(120);
  ["M", "T", "W", "T", "F", "S", "S"].forEach((d, i) => {
    doc.text(d, rightX + labelW + i * dayColW + dayColW / 2 - 2, rightY);
  });
  doc.setTextColor(0);
  rightY += 6;

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
      // Counter rows are taller for prominence; non-counter rows are compact.
      const rowH = isCounter ? 34 : 22;

      doc.setFontSize(10);
      doc.text(truncate(t.title, 22), rightX, rightY + 10);
      doc.setFontSize(7);
      doc.setTextColor(150);
      const meta = [
        t.specificTime ? `⏰ ${t.specificTime}` : (t.timeOfDay ?? "anytime"),
        isCounter ? `target ${target}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      doc.text(meta, rightX, rightY + 20);
      doc.setTextColor(0);

      if (isCounter) {
        // Bigger blocks per day so each glass / unit is easy to tick.
        // Lay out target boxes in a 2-row grid if target > what fits in one row.
        const maxPerRow = Math.max(3, Math.floor(dayColW / 6));
        const perRow = Math.min(target, maxPerRow);
        const rows = Math.ceil(target / perRow);
        const boxSize = Math.max(4.5, Math.min(6.5, (dayColW - 4) / perRow - 1));
        const gridH = rows * (boxSize + 1);
        const gridY = rightY + 9 - (gridH - boxSize) / 2;

        for (let d = 0; d < 7; d++) {
          const colX = rightX + labelW + d * dayColW + 2;
          for (let n = 0; n < target; n++) {
            const r = Math.floor(n / perRow);
            const c = n % perRow;
            checkbox(
              colX + c * (boxSize + 1),
              gridY + r * (boxSize + 1) + boxSize - 1,
              boxSize,
            );
          }
          // Per-day "0/N" hint, slightly larger
          doc.setFontSize(6.5);
          doc.setTextColor(160);
          doc.text(
            `0/${target}`,
            rightX + labelW + d * dayColW + dayColW / 2 - 7,
            rightY + rowH - 4,
          );
          doc.setTextColor(0);
        }
      } else {
        for (let d = 0; d < 7; d++) {
          checkbox(rightX + labelW + d * dayColW + dayColW / 2 - 5, rightY + 11, 10);
        }
      }
      rightY += rowH;
    }
  }

  rightY += 14;

  // ── Backlog (moved here) ──────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Backlog — other tasks by due date", rightX, rightY);
  rightY += 6;
  doc.setDrawColor(220);
  doc.line(rightX, rightY, rightX + colW, rightY);
  rightY += 12;

  // Reserve a fixed-height doodle box at the bottom (smaller than before).
  const DOODLE_H = 90;
  const footerH = 16;
  const backlogMaxY = pageH - margin - DOODLE_H - footerH - 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  for (const t of others) {
    if (rightY > backlogMaxY - 11) {
      doc.setTextColor(150);
      doc.text(
        `+${others.length - others.indexOf(t)} more — see app`,
        rightX,
        rightY,
      );
      doc.setTextColor(0);
      break;
    }
    checkbox(rightX, rightY, 7);
    doc.text(truncate(t.title, 50), rightX + 12, rightY);
    doc.setTextColor(120);
    doc.text(
      `${dueLabel(t.dueDate)}  ·  ${t.urgency}  ·  ${t.theme}  ·  ${shortId(t.id)}`,
      rightX + colW - 165,
      rightY,
    );
    doc.setTextColor(0);
    rightY += 11;
  }

  // ── Notes / doodles (smaller, fixed height) ───────────────────────────────
  const doodleY = pageH - margin - DOODLE_H - footerH - 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Notes / doodles", rightX, doodleY - 4);
  doc.setFont("helvetica", "normal");

  doc.setDrawColor(210);
  doc.setLineWidth(0.5);
  doc.rect(rightX, doodleY, colW, DOODLE_H);
  doc.setFillColor(220, 220, 220);
  for (let gx = rightX + 12; gx < rightX + colW - 6; gx += 14) {
    for (let gy = doodleY + 12; gy < doodleY + DOODLE_H - 6; gy += 14) {
      doc.circle(gx, gy, 0.35, "F");
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(
    "Mark ✓ to complete · write 'DEFER' or 'BLOCKED' next to a task · keep the wave code + #ID stamps intact for scan-back.",
    margin,
    pageH - 8,
  );

  const stamp = start.toISOString().slice(0, 10);
  doc.save(`Focus3-week-${stamp}.pdf`);
}
