import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

export const scanPlannerRouter = Router();

const SYSTEM_PROMPT = `You read a scanned-and-OCR'd Focus3 planner page and extract per-task status changes.

The planner prints each task with a short ID stamp like "#abc123" (last 6 chars of the task id). Use those stamps to map updates back to the right task.

Recognise these handwritten markings near a task line:
- A ticked checkbox (✓, X, filled box, "DONE") → action: "complete"
- "DEFER" or "SNOOZE" → action: "defer", value = a number of days if written ("DEFER 3" → 3), otherwise default 7
- "BLOCKED" or "BLOCK" → action: "block" (we'll snooze 14 days as a recheck)
- "Time spent: N" / "spent Nm" / "Nh" → action: "timeSpent", value = minutes (1h = 60)
- An edit to the task title (e.g. crossed out + new text written nearby) → action: "rename", value = new title

A task may have multiple actions (e.g. completed AND time spent). Emit one record per action.

Respond with strict JSON only:
{
  "updates": [
    { "shortId": "#abc123", "action": "complete" | "defer" | "block" | "timeSpent" | "rename", "value": "<string or number, optional>", "evidence": "<the text snippet you matched>" }
  ]
}

If you can't match a stamp confidently, omit it. Do not invent IDs or actions.`;

interface ScanRequest {
  text?: string;
  /** Optional list of known shortIds we generated, helps Claude avoid hallucinations. */
  shortIds?: string[];
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence ? fence[1]! : trimmed);
}

scanPlannerRouter.post("/", async (req, res) => {
  const { text, shortIds } = (req.body ?? {}) as ScanRequest;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res
      .status(503)
      .json({ error: "anthropic_not_configured", message: "Set ANTHROPIC_API_KEY" });
  }
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "empty_text" });
  }
  if (text.length > 30_000) {
    return res.status(413).json({ error: "text_too_long" });
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

  const userMsg = [
    shortIds && shortIds.length > 0
      ? `Known task IDs in this planner: ${shortIds.join(", ")}`
      : "",
    "Scanned planner text:",
    text,
  ]
    .filter(Boolean)
    .join("\n\n");

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
      messages: [{ role: "user", content: userMsg }],
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
