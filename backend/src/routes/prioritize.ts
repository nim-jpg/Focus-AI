import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

export const prioritizeRouter = Router();

const SYSTEM_PROMPT = `You are Focus3, an anti-procrastination assistant for neurodivergent users.

Pick the user's top three tasks for today using these tiers (in order):
- Tier 1 (Must do now): medication due today, hard deadlines within 48h, commitments to others.
- Tier 2 (Move forward): tasks that unlock other work, finance cutoffs, fitness/learning consistency.
- Tier 3 (Balance): spread across themes; don't surface 3 work tasks if personal is crumbling; flag avoidance >2 weeks when deadline <2 weeks.
- Tier 4 (Background): household, nice-to-haves, long-term unless deadline imminent.

Rules:
- Never surface three tasks from the same theme unless every other theme is clear.
- Respect the user's calendar capacity.
- Output one-line reasoning per task — concrete and specific.

Respond with strict JSON, no prose, no markdown fences:
{ "topThree": [ { "taskId": "<id from input>", "tier": 1, "reasoning": "..." } ] }`;

interface InboundTask {
  id: string;
  [k: string]: unknown;
}

interface PrioritizeRequest {
  tasks: InboundTask[];
  prefs?: unknown;
  calendar?: unknown;
}

interface ClaudeResponse {
  topThree: Array<{ taskId: string; tier: 1 | 2 | 3 | 4; reasoning: string }>;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Tolerate accidental ```json fences.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]! : trimmed;
  return JSON.parse(body);
}

prioritizeRouter.post("/", async (req, res) => {
  const { tasks, prefs, calendar } = (req.body ?? {}) as PrioritizeRequest;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "anthropic_not_configured",
      message:
        "ANTHROPIC_API_KEY is not set. The frontend will fall back to its local heuristic.",
    });
  }

  if (!Array.isArray(tasks)) {
    return res.status(400).json({ error: "invalid_tasks" });
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
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
          content: JSON.stringify({ tasks, prefs, calendar }),
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = extractJson(text) as ClaudeResponse;

    if (!parsed || !Array.isArray(parsed.topThree)) {
      return res.status(502).json({
        error: "invalid_model_response",
        message: "Model did not return the expected shape.",
        raw: text,
      });
    }

    // Drop any taskIds the model invented.
    const validIds = new Set(tasks.map((t) => t.id));
    const topThree = parsed.topThree
      .filter((p) => validIds.has(p.taskId))
      .slice(0, 3);

    res.json({ topThree, source: "claude" as const });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    res.status(500).json({ error: "anthropic_error", message });
  }
});
