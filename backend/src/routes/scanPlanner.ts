import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

export const scanPlannerRouter = Router();

const SYSTEM_PROMPT = `You read a photographed / scanned Focus3 weekly planner page and extract per-task status changes by VISUALLY inspecting the page.

Layout cues:
- Each task row has a wave-code stamp (a row of pill-shaped grey bars, centred horizontally) and a "#abc123" short-id text underneath the wave. Use the wave + shortId to identify the task and to anchor the row.
- Each task row also has printed checkboxes labelled "defer" and "blocked", a "time:" field with an underline, and a "notes:" line.
- Stretch tasks appear in a separate table with columns TASK / DUE / URGENCY / THEME and a small wave-code in the right-hand column.

Per-task markings to recognise (look at the visual area aligned with each wave / shortId):
- Tick / cross / filled mark in the "defer" checkbox → action: "defer", value = a number of days if written next to it ("DEFER 3" → 3), else default 7
- Tick / cross / filled mark in the "blocked" checkbox → action: "block"
- A tick / cross / filled mark anywhere on the row, OR "DONE" written near the task → action: "complete"
- Handwritten "Time: 30m" / "1h" / "45 min" inside the time field → action: "timeSpent", value = minutes (1h = 60)
- A struck-through task title with new text handwritten beside / below it → action: "rename", value = new title

Use SPATIAL alignment to attribute markings to the correct task: a tick must be in the same row band as the task's wave-code, not a neighbour's. If a marking is ambiguous (not clearly aligned to one row), omit it.

A task may have multiple actions (e.g. defer AND time spent). Emit one record per action.

Respond with strict JSON only — no prose, no markdown fences:
{
  "updates": [
    { "shortId": "#abc123", "action": "complete" | "defer" | "block" | "timeSpent" | "rename", "value": "<string or number, optional>", "evidence": "<short description of what you saw>" }
  ]
}

If you can't match a stamp confidently, omit it. Do not invent IDs or actions.`;

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
   *  hallucinations and grounds the row mapping. */
  shortIds?: string[];
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence ? fence[1]! : trimmed);
}

scanPlannerRouter.post("/", async (req, res) => {
  const { imageBase64, mediaType, text, shortIds } = (req.body ?? {}) as ScanRequest;
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
      ? `Known task IDs printed on this planner: ${shortIds.join(", ")}.`
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
      text: [knownIds, "Scanned planner text:", text!]
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
