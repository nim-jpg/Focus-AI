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
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
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

/**
 * AI-rank shape — taskId → tier (1 best, 4 background). When supplied,
 * the stretch picker sorts candidates by this rank first and falls back
 * to the local heuristic for anything not yet ranked by Claude.
 */
export type AiRankMap = Map<string, 1 | 2 | 3 | 4>;

/**
 * Far-future yearly / quarterly filings (annual accounts, VAT returns,
 * etc.) shouldn't pad the printable stretch list every week — the user has
 * weeks/months of runway. They reappear when the deadline is genuinely close.
 */
function isFarFutureFiling(t: Task): boolean {
  if (t.recurrence !== "yearly" && t.recurrence !== "quarterly") return false;
  if (!t.dueDate) return false;
  const daysOut = (new Date(t.dueDate).getTime() - Date.now()) / 86400000;
  return daysOut > 30;
}

function pickStretchTasks(
  tasks: Task[],
  prefs: UserPrefs,
  weekStart: Date,
  excludeIds: Set<string>,
  count = 8,
  aiRanking?: AiRankMap,
): Task[] {
  const baseFilter = (t: Task): boolean =>
    !excludeIds.has(t.id) &&
    isSignificantWorkItem(t) &&
    !isFarFutureFiling(t);
  if (aiRanking && aiRanking.size > 0) {
    // Use Claude's ranking when available — keeps the PDF stretch list in
    // step with the same priority view the user is acting on in the app.
    // Tasks not in the AI cache are appended via the local heuristic.
    const ranked = tasks
      .filter(baseFilter)
      .filter((t) => aiRanking.has(t.id))
      .sort(
        (a, b) =>
          (aiRanking.get(a.id) ?? 5) - (aiRanking.get(b.id) ?? 5),
      );
    if (ranked.length >= count) return ranked.slice(0, count);
    const seen = new Set(ranked.map((t) => t.id));
    const filler = prioritize(tasks, { prefs, limit: 32, now: weekStart })
      .map((p) => p.task)
      .filter((t) => !seen.has(t.id) && baseFilter(t));
    return [...ranked, ...filler].slice(0, count);
  }
  const candidates = prioritize(tasks, { prefs, limit: 32, now: weekStart })
    .map((p) => p.task)
    .filter(baseFilter);
  return candidates.slice(0, count);
}

/**
 * Fluids tracker — a 7-day grid for tallying everything you drink. Each cell
 * is a uniform 8-box grid (consistent across all rows and days) — tick a box
 * per cup / glass / can as you go. No per-day total column; labels carry the
 * "aim high / minimise" hint instead.
 */
function drawFluidsTracker(
  doc: import("jspdf").jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Fluids tracker", x, y - 4);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(140);
  doc.text("tick a box per cup — aim water high, fizzy + caffeine low", x + 92, y - 4);
  doc.setTextColor(0);

  doc.setDrawColor(210);
  doc.setLineWidth(0.5);
  doc.rect(x, y, w, h);

  // Rows: water (aim high), tea (ok), coffee (caffeine — minimise), fizzy (minimise!).
  const rows: Array<{
    label: string;
    hint: string;
    tint: [number, number, number];
    hintColour: [number, number, number];
  }> = [
    { label: "WATER",   hint: "aim high",  tint: [219, 234, 254], hintColour: [29, 78, 216] },
    { label: "TEA",     hint: "ok",        tint: [254, 226, 226], hintColour: [120, 53, 15] },
    { label: "COFFEE",  hint: "caffeine — minimise", tint: [231, 207, 184], hintColour: [120, 53, 15] },
    { label: "FIZZY",   hint: "minimise",  tint: [233, 213, 255], hintColour: [126, 34, 206] },
  ];

  const labelW = 60; // wider label column to fit "minimise" hint
  const dayColW = (w - labelW - 4) / 7;
  const headerY = y + 12;

  // Day headers
  doc.setFontSize(7);
  doc.setTextColor(120);
  ["M", "T", "W", "T", "F", "S", "S"].forEach((d, i) => {
    doc.text(d, x + labelW + i * dayColW + dayColW / 2 - 2, headerY);
  });
  doc.setTextColor(0);

  const gridTop = headerY + 4;
  const rowH = (h - 16) / rows.length;

  // Uniform: 8 boxes per cell, every row, every day.
  const BOXES = 8;

  rows.forEach((row, rIdx) => {
    const rowY = gridTop + rIdx * rowH;
    doc.setFillColor(row.tint[0], row.tint[1], row.tint[2]);
    doc.rect(x + labelW - 2, rowY, w - labelW + 2, rowH - 1, "F");

    // Label + hint (stacked)
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(60);
    doc.text(row.label, x + 4, rowY + rowH / 2 - 1);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6);
    doc.setTextColor(row.hintColour[0], row.hintColour[1], row.hintColour[2]);
    doc.text(row.hint, x + 4, rowY + rowH / 2 + 8);
    doc.setTextColor(0);

    // Uniform 8-box grid per day cell
    const boxSize = Math.max(3, Math.min(4.5, (dayColW - 4) / BOXES - 0.4));
    for (let d = 0; d < 7; d++) {
      const colX = x + labelW + d * dayColW + 2;
      for (let n = 0; n < BOXES; n++) {
        const bx = colX + n * (boxSize + 0.4);
        const by = rowY + (rowH - boxSize) / 2;
        doc.setDrawColor(120);
        doc.setLineWidth(0.4);
        doc.rect(bx, by, boxSize, boxSize);
      }
    }
  });
}

/** Single-page A4 landscape weekly planner. */
export async function exportWeeklyPlanner(
  tasks: Task[],
  prefs: UserPrefs,
  aiRanking?: AiRankMap,
): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 28;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * DAY_MS);

  // Privacy: drop tasks whose theme is on the user's PDF exclude list (default: medication).
  const excludedThemes = new Set(prefs.pdfExcludeThemes ?? ["medication"]);
  const allowedTasks = tasks.filter((t) => !excludedThemes.has(t.theme));

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
  // Each task gets a Spotify-style wave bar (visual brand) + the shortId text
  // underneath (OCR-readable for scan-back). Right-aligned in lists.
  const WAVE_W = 70;
  const WAVE_H = 12;
  const WAVE_BARS = 20;
  const CODE_W = WAVE_W;

  const drawCodes = (taskId: string, x: number, y: number) => {
    const seq = hashSeq(taskId, WAVE_BARS);
    doc.setFillColor(60, 60, 60);
    // Anchor dot vertically centred with the wave.
    doc.circle(x + 3, y + WAVE_H / 2, 1.6, "F");
    const barAreaX = x + 8;
    const barAreaW = WAVE_W - 8;
    const barW = (barAreaW - (WAVE_BARS - 1) * 1) / WAVE_BARS;
    const midY = y + WAVE_H / 2;
    for (let i = 0; i < WAVE_BARS; i++) {
      const tier = seq[i] % 3;
      // Each bar has equal half-height above and below the midline so the
      // wave reads as a centered pill row, not bars rising from a baseline.
      const bh = WAVE_H * (0.35 + tier * 0.32);
      const bx = barAreaX + i * (barW + 1);
      const by = midY - bh / 2;
      // Rounded rectangle with corner radius = barW/2 produces semicircular
      // (pill-shaped) caps at the top and bottom of every bar.
      doc.roundedRect(bx, by, barW, bh, barW / 2, barW / 2, "F");
    }
    // shortId text under the wave (OCR scan-back fallback)
    doc.setFontSize(5.5);
    doc.setTextColor(170);
    doc.text(shortId(taskId), x, y + WAVE_H + 6);
    doc.setTextColor(0);
  };

  // ── Header ────────────────────────────────────────────────────────────────
  let y = margin + 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Focus3 — Weekly Planner", margin, y + 6);

  // Date range
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `${start.toLocaleDateString()}  to  ${new Date(end.getTime() - 1).toLocaleDateString()}`,
    margin + 230,
    y + 6,
  );
  doc.setTextColor(0);

  // Mode pill — coloured badge so it's instantly clear which lens this planner is for
  const modeLabel = `Mode: ${prefs.mode.toUpperCase()}`;
  const modeBg: [number, number, number] = prefs.mode === "work"
    ? [219, 234, 254] // blue
    : prefs.mode === "personal"
    ? [243, 232, 255] // purple
    : [220, 252, 231]; // green for both
  const modeFg: [number, number, number] = prefs.mode === "work"
    ? [30, 64, 175]
    : prefs.mode === "personal"
    ? [88, 28, 135]
    : [22, 101, 52];
  doc.setFontSize(9);
  const modeW = doc.getTextWidth(modeLabel) + 12;
  const modeX = pageW - margin - modeW;
  doc.setFillColor(modeBg[0], modeBg[1], modeBg[2]);
  doc.roundedRect(modeX, y, modeW, 16, 8, 8, "F");
  doc.setTextColor(modeFg[0], modeFg[1], modeFg[2]);
  doc.text(modeLabel, modeX + 6, y + 11);
  doc.setTextColor(0);

  y += 28;

  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 22; // more space after the divider

  // Build content for each task list. Stretch capacity is computed from the
  // space left in the left column after key tasks and the fluids tracker —
  // we want to fill the gap, not leave it empty.
  const keyTasks = pickKeyTasks(allowedTasks, prefs, start, end);
  const keyIds = new Set(keyTasks.map((t) => t.id));
  // Reserve at the bottom-left for the fluids tracker (and footer).
  const FLUIDS_H = 110;
  const FOOTER_H = 16;
  const STRETCH_ROW_H = 26;
  const KEY_ROW_H = 50;
  // Approximate y after key tasks (24pt section header + 14pt gap + N rows + 6pt gap)
  const keyEndsY = y + 18 + keyTasks.length * KEY_ROW_H + 6;
  const stretchHeader = 18; // header + divider
  const stretchAvailableY = pageH - margin - FLUIDS_H - FOOTER_H - 30 - keyEndsY - stretchHeader;
  const stretchCapacity = Math.max(5, Math.floor(stretchAvailableY / STRETCH_ROW_H));
  const stretchTasks = pickStretchTasks(
    allowedTasks,
    prefs,
    start,
    keyIds,
    stretchCapacity,
    aiRanking,
  );
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
        leftY + 11,
      );
      doc.setTextColor(0);

      // Code stamp, right-aligned
      drawCodes(t.id, leftCodeX, leftY - 4);

      // Action row: tick boxes for defer / blocked, time-spent slot
      const actionY = leftY + 22;
      doc.setFontSize(7);
      doc.setTextColor(120);

      let cursor = leftX + 16;
      doc.text("time:", cursor, actionY);
      cursor += 18;
      // underline for time value
      doc.setDrawColor(180);
      doc.line(cursor, actionY + 1, cursor + 28, actionY + 1);
      cursor += 36;

      // Defer tick + label
      checkbox(cursor, actionY, 7);
      doc.text("defer", cursor + 10, actionY);
      cursor += 38;

      // Blocked tick + label
      checkbox(cursor, actionY, 7);
      doc.text("blocked", cursor + 10, actionY);

      doc.setTextColor(0);

      // Notes line on a fresh row underneath
      const notesY = leftY + 32;
      doc.setFontSize(7);
      doc.setTextColor(120);
      doc.text("notes:", leftX + 16, notesY);
      doc.setDrawColor(220);
      doc.line(leftX + 16 + 22, notesY + 1, leftCodeX - 8, notesY + 1);
      doc.setTextColor(0);

      leftY += 50; // taller row to accommodate the new fields
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
      drawCodes(t.id, leftCodeX, leftY - 4);
      doc.setFontSize(9);
      leftY += 26; // was 22 — more breathing room per stretch row
    }
  }

  // (Backlog moved to right column under Daily habits)
  // Pre-compute the others list — it's rendered later in the right column.
  const others = allowedTasks
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
  const dailyTasks = allowedTasks
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

  rightY += 18; // more breathing room before backlog

  // ── Backlog (right column) ────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Backlog — other tasks", rightX, rightY);
  rightY += 8;
  doc.setDrawColor(220);
  doc.line(rightX, rightY, rightX + colW, rightY);
  rightY += 18; // generous gap before the column header / first row

  // Column header row — three columns now (no #ID), wider THEME so words like
  // "development", "household" render in full.
  doc.setFontSize(6.5);
  doc.setTextColor(140);
  const colTitleX = rightX + 14;
  const colDueX = rightX + colW - 150;
  const colUrgencyX = rightX + colW - 100;
  const colThemeX = rightX + colW - 60;
  doc.text("TASK", colTitleX, rightY);
  doc.text("DUE", colDueX, rightY);
  doc.text("URGENCY", colUrgencyX, rightY);
  doc.text("THEME", colThemeX, rightY);
  doc.setTextColor(0);
  rightY += 12;

  // Faint theme-color stripe + alternating-row tint for scannability.
  const themeStripeColour: Record<string, [number, number, number]> = {
    work: [37, 99, 235],
    projects: [79, 70, 229],
    personal: [126, 34, 206],
    school: [219, 39, 119],
    fitness: [22, 163, 74],
    finance: [202, 138, 4],
    diet: [234, 88, 12],
    medication: [220, 38, 38],
    development: [13, 148, 136],
    household: [100, 116, 139],
  };

  // Reserve a fluids tracker (bottom-LEFT) and a notes box (bottom-RIGHT).
  // Notes box is dynamic — it fills whatever space backlog leaves.
  const NOTES_MIN_H = 80;
  const backlogMaxY = pageH - margin - NOTES_MIN_H - FOOTER_H - 26;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  let rowIdx = 0;
  for (const t of others) {
    if (rightY > backlogMaxY - 13) {
      doc.setTextColor(150);
      doc.text(
        `+${others.length - others.indexOf(t)} more — see app`,
        rightX + 14,
        rightY + 4,
      );
      doc.setTextColor(0);
      break;
    }
    if (rowIdx % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(rightX, rightY - 7, colW, 13, "F");
    }
    const stripe = themeStripeColour[t.theme] ?? [148, 163, 184];
    doc.setFillColor(stripe[0], stripe[1], stripe[2]);
    doc.rect(rightX, rightY - 7, 2, 13, "F");

    checkbox(rightX + 6, rightY, 7); // 8pt gap from text
    doc.text(truncate(t.title, 38), colTitleX, rightY);
    doc.setTextColor(120);
    doc.text(dueLabel(t.dueDate), colDueX, rightY);
    doc.text(t.urgency, colUrgencyX, rightY);
    // Full theme word — no truncation
    doc.text(t.theme, colThemeX, rightY);
    doc.setTextColor(0);
    rightY += 13;
    rowIdx++;
  }

  // ── Fluids tracker (BOTTOM-LEFT) ──────────────────────────────────────────
  drawFluidsTracker(doc, leftX, pageH - margin - FLUIDS_H - FOOTER_H, colW, FLUIDS_H);

  // ── Notes / doodles (BOTTOM-RIGHT, fills remaining space) ─────────────────
  const notesTop = rightY + 14;
  const notesBottom = pageH - margin - FOOTER_H - 4;
  const notesH = Math.max(NOTES_MIN_H, notesBottom - notesTop);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Notes / doodles", rightX, notesTop - 4);
  doc.setFont("helvetica", "normal");

  doc.setDrawColor(210);
  doc.setLineWidth(0.5);
  doc.rect(rightX, notesTop, colW, notesH);
  // Horizontal writing lines — spaced wide enough (~22pt ≈ 7.7mm) so a
  // pen actually fits on the line without crowding adjacent rows.
  const NOTES_LINE_GAP = 22;
  doc.setDrawColor(220);
  doc.setLineWidth(0.4);
  for (let gy = notesTop + NOTES_LINE_GAP; gy < notesTop + notesH - 4; gy += NOTES_LINE_GAP) {
    doc.line(rightX + 6, gy, rightX + colW - 6, gy);
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
