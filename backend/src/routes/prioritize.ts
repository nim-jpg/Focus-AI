import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

export const prioritizeRouter = Router();

const SYSTEM_PROMPT = `You are Focus3, an anti-procrastination assistant for neurodivergent users.

Tier EVERY task in the input using:
- Tier 1 (Must do now): medication due today, hard deadlines within 48h, commitments to others.
- Tier 2 (Move forward): tasks that unlock other work, finance cutoffs, fitness/learning consistency.
- Tier 3 (Balance): spread across themes; don't crowd one theme; flag avoidance >2 weeks when deadline <2 weeks.
- Tier 4 (Background): household, nice-to-haves, long-term unless deadline imminent.

Rules:
- Output a tier and one short concrete reasoning sentence for EVERY task in the input.
- Within each tier, order the tasks from most to least important.
- Never invent task ids — use only the ids you were given.
- Respect the user's calendar capacity.
- The frontend will filter and slice the top three from this ranked list based on the user's current mode (work / personal / both), so don't drop tasks just because they're off-mode.

Respond with strict JSON, no prose, no markdown fences:
{ "ranked": [ { "taskId": "<id>", "tier": 1, "reasoning": "..." } ] }`;

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
  ranked: Array<{ taskId: string; tier: 1 | 2 | 3 | 4; reasoning: string }>;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Tolerate accidental ```json fences.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]! : trimmed;
  try {
    return JSON.parse(body);
  } catch (err) {
    // Recovery for the case where the model hit max_tokens mid-array and
    // the trailing object is truncated. Walk back to the last complete
    // `}` and close the array. Better to lose the last task than to
    // throw away the whole ranking.
    if (err instanceof SyntaxError && body.includes('"ranked"')) {
      const lastClose = body.lastIndexOf("}");
      if (lastClose > 0) {
        const fixed = body.slice(0, lastClose + 1) + "]}";
        try {
          return JSON.parse(fixed);
        } catch {
          /* fall through */
        }
      }
    }
    throw err;
  }
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
      // The prompt now ranks EVERY candidate (tier + one-line reasoning per
      // task), so the response scales with the user's open-task count.
      // 8k leaves comfortable headroom for ~150-200 tasks before truncation.
      max_tokens: 8192,
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

    if (!parsed || !Array.isArray(parsed.ranked)) {
      return res.status(502).json({
        error: "invalid_model_response",
        message: "Model did not return the expected shape.",
        raw: text,
      });
    }

    // Drop any taskIds the model invented.
    const validIds = new Set(tasks.map((t) => t.id));
    const ranked = parsed.ranked.filter((p) => validIds.has(p.taskId));

    res.json({ ranked, source: "claude" as const });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    res.status(500).json({ error: "anthropic_error", message });
  }
});
