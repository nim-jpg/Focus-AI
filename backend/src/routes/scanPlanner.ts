import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

export const scanPlannerRouter = Router();

const SYSTEM_PROMPT = `You read a photographed / scanned Focus3 weekly planner page and extract status changes by VISUALLY inspecting the page.

The page has SEVERAL distinct sections — process them ALL:

1. KEY TASKS (left column, top) — each has a wave-code stamp (pill-shaped grey bars), a "#abc123" short-id underneath, printed "defer" + "blocked" checkboxes, a "time:" field, and a "notes:" line.
2. STRETCH TASKS (left column, middle) — each has a wave-code on the right and a "#abc123" stamp.
3. BACKLOG (right column, table form) — each row has a single checkbox on the left, the task title, then DUE / URGENCY / THEME columns. NO shortId is printed — use the task TITLE to attribute the row (match against the "Known task titles" list provided).
4. DAILY HABITS (right column, top) — each row has a habit title and meta line, then 7 day-columns (M T W T F S S) of either single checkboxes (non-counter habits) or a grid of small boxes (counter habits — water glasses, pushup sets, etc.). NO shortId is printed — match by TITLE.
5. NOTES / DOODLES (bottom-right) — a blank box for the user to handwrite anything.
6. FLUIDS TRACKER (bottom-left) — a 7-day grid for water / tea / coffee / fizzy. SKIP THIS — the app doesn't yet track fluids; ignore any ticks here.

Per-section actions to emit:

KEY / STRETCH / BACKLOG (anchor by shortId, look at the row band aligned with the wave/stamp):
- Tick in the "defer" checkbox → action: "defer", value = a number of days if written ("DEFER 3" → 3), else 7
- Tick in the "blocked" checkbox → action: "block"
- Tick on a backlog row's checkbox, OR a tick / cross / filled mark anywhere on a key/stretch row, OR "DONE" written near the task → action: "complete"
- Handwritten "Time: 30m" / "1h" / "45 min" in the time field (key tasks only) → action: "timeSpent", value = minutes (1h = 60)
- Struck-through task title with new text handwritten beside / below → action: "rename", value = new title

DAILY HABITS (anchor by shortId on each habit row):
- For non-counter habits: each ticked DAY box → action: "habitTick", value = { "day": "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun" }
- For counter habits: count the ticked small boxes for each day → action: "habitTick", value = { "day": "Mon"...., "count": <integer> }
- Emit one "habitTick" per day that has at least one tick. Don't emit zero-count records.

NOTES / DOODLES box:
- If the user has written something in the notes box, transcribe it as faithfully as possible (typed) → action: "newNote", value = the transcribed text. Use shortId "" (empty) if it's not clearly attributed to a specific task.

Spatial-alignment rule: a tick MUST sit in the same row band as the row's wave or shortId stamp. If ambiguous, omit it.

A task may have multiple actions (e.g. defer AND time spent). Emit one record per action.

For each update, set EITHER shortId (when the row has a printed "#abc123" stamp — key tasks and stretch tasks) OR taskTitle (when matching by row title — backlog and daily habits). The frontend resolves whichever you provide.

Respond with strict JSON only — no prose, no markdown fences:
{
  "updates": [
    { "shortId": "#abc123", "taskTitle": "<exact or close match to a known title>", "action": "complete" | "defer" | "block" | "timeSpent" | "rename" | "habitTick" | "newNote", "value": "<string, number, or object, optional>", "evidence": "<short description of what you saw>" }
  ]
}

If you can't match a row confidently to either a shortId OR a known title, omit it. Do not invent IDs, titles, or actions.`;

interface ScanRequest {
  /** Optional photograph / scan of the planner as a base64-encoded
   *  data URL or raw base64. When supplied, Claude reads the image
   *  directly (preferred). */
  imageBase64?: string;
  /** Image media type (e.g. "image/jpeg", "image/png"). Defaults to "image/jpeg". */
  mediaType?: string;
  /** Fallback OCR text — used when no image is provided. Less reliable
   *  because Claude loses spatial cues. */
  text?: string;
  /** Optional list of known shortIds we generated; helps Claude avoid
   *  hallucinations and grounds the row mapping for key/stretch tasks. */
  shortIds?: string[];
  /** Open task titles printed on the planner — used to attribute marks
   *  in sections that don't print shortIds (backlog, daily habits). */
  taskTitles?: string[];
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence ? fence[1]! : trimmed);
}

scanPlannerRouter.post("/", async (req, res) => {
  const { imageBase64, mediaType, text, shortIds, taskTitles } = (req.body ?? {}) as ScanRequest;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res
      .status(503)
      .json({ error: "anthropic_not_configured", message: "Set ANTHROPIC_API_KEY" });
  }
  const haveImage = typeof imageBase64 === "string" && imageBase64.length > 0;
  const haveText = typeof text === "string" && text.trim().length > 0;
  if (!haveImage && !haveText) {
    return res.status(400).json({ error: "missing_input" });
  }
  if (haveText && (text!.length > 30_000)) {
    return res.status(413).json({ error: "text_too_long" });
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

  // Build the user message — image-first when available, falling back to
  // the OCR text.
  const knownIds =
    shortIds && shortIds.length > 0
      ? `Known task IDs (key + stretch): ${shortIds.join(", ")}.`
      : "";
  const knownTitles =
    taskTitles && taskTitles.length > 0
      ? `Known task titles (use these to attribute backlog & habit rows by text):\n- ${taskTitles.slice(0, 200).join("\n- ")}`
      : "";
  const content: Anthropic.MessageParam["content"] = [];
  if (haveImage) {
    // Strip a "data:image/...;base64," prefix if present.
    const cleaned = imageBase64!.replace(/^data:[^;]+;base64,/, "");
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: (mediaType as Anthropic.Base64ImageSource["media_type"]) ?? "image/jpeg",
        data: cleaned,
      },
    });
    content.push({
      type: "text",
      text: [
        knownIds,
        knownTitles,
        "Read the planner image above and emit the JSON described in the system prompt.",
        haveText
          ? `For reference, here is the OCR text extracted from the same image:\n${text!.slice(0, 8000)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  } else {
    content.push({
      type: "text",
      text: [knownIds, knownTitles, "Scanned planner text:", text!]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content }],
    });

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = extractJson(raw) as { updates?: unknown };
    if (!parsed || !Array.isArray(parsed.updates)) {
      return res
        .status(502)
        .json({ error: "invalid_model_response", message: "Bad shape", raw });
    }
    res.json({ updates: parsed.updates });
  } catch (err) {
    res.status(500).json({
      error: "anthropic_error",
      message: err instanceof Error ? err.message : "unknown",
    });
  }
});
