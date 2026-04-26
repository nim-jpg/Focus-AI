import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

export const suggestGoalTasksRouter = Router();

const SYSTEM_PROMPT = `You decide which of the user's open tasks should ladder up to a specific long-term goal.

You'll be given:
- one goal (title, horizon, theme, optional notes explaining why it matters)
- a list of open, currently-unlinked tasks (id, title, optional description, theme)

Pick tasks that *plausibly contribute* to achieving the goal. Be generous when there's a clear thematic link or the task obviously moves the needle on the goal, but don't pad — if a task is unrelated, skip it. Quality over quantity.

For each pick, emit:
{ "taskId": "<id>", "confidence": "high"|"medium"|"low", "reason": "<one short sentence on why this ladders to the goal>" }

If nothing in the list fits, return an empty array.

Respond with strict JSON only, no prose, no fences:
{ "matches": [ { ... } ] }`;

interface SuggestRequest {
  goal?: {
    title?: string;
    horizon?: string;
    theme?: string;
    notes?: string;
  };
  tasks?: Array<{
    id: string;
    title: string;
    description?: string;
    theme?: string;
  }>;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence ? fence[1]! : trimmed);
}

suggestGoalTasksRouter.post("/", async (req, res) => {
  const { goal, tasks } = (req.body ?? {}) as SuggestRequest;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "anthropic_not_configured",
      message: "ANTHROPIC_API_KEY is not set.",
    });
  }
  if (!goal || typeof goal.title !== "string" || goal.title.trim().length === 0) {
    return res.status(400).json({ error: "missing_goal" });
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.json({ matches: [] });
  }

  const slimTasks = tasks.slice(0, 100).map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description?.slice(0, 200),
    theme: t.theme,
  }));

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

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
      messages: [
        {
          role: "user",
          content: [
            "goal:",
            JSON.stringify(goal, null, 2),
            "",
            "open unlinked tasks:",
            JSON.stringify(slimTasks, null, 2),
          ].join("\n"),
        },
      ],
    });

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = extractJson(raw) as { matches?: unknown };
    if (!parsed || !Array.isArray(parsed.matches)) {
      return res
        .status(502)
        .json({ error: "invalid_model_response", message: "Bad shape", raw });
    }

    res.json({ matches: parsed.matches });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    res.status(500).json({ error: "anthropic_error", message });
  }
});
