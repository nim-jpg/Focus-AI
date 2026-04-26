import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

export const suggestDueDatesRouter = Router();

const SYSTEM_PROMPT = `You suggest due dates for tasks where one is missing AND can be inferred from text alone.

ONLY suggest a date when one of these signals is present:
1. Explicit date hint in the title or description: "by Friday", "EOM", "in March", "Q2", "next Tuesday", "the 15th", a specific date, etc.
2. A standard recurring deadline that depends only on the calendar (NOT on company-specific data):
   - "Self Assessment" / "tax return" (UK): 31 January following the tax year
   - "VAT return" (UK): standard quarter ending → due 1 month + 7 days after
   - "P11D": 6 July following the tax year

DO NOT guess for these — they require external lookup and the app handles them separately:
   - "confirmation statement", "annual accounts", "annual return" — these depend on the company's incorporation date and must come from Companies House. Skip these tasks entirely; do not invent a date.
   - Anything tied to a specific person/company/account whose schedule isn't in the task text.

For each task you can confidently date, emit:
{ "taskId": "<id>", "dueDate": "YYYY-MM-DD", "confidence": "high"|"medium", "reasoning": "<one short sentence pointing to the text hint>" }

If you can't infer a date with confidence, omit the task from suggestions. It is much better to skip than to guess.

Respond with strict JSON only:
{ "suggestions": [ { ... } ] }`;

interface SuggestRequest {
  tasks?: Array<{
    id: string;
    title: string;
    description?: string;
    theme?: string;
    dueDate?: string;
  }>;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence ? fence[1]! : trimmed);
}

suggestDueDatesRouter.post("/", async (req, res) => {
  const { tasks } = (req.body ?? {}) as SuggestRequest;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "anthropic_not_configured",
      message: "ANTHROPIC_API_KEY is not set.",
    });
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: "no_tasks" });
  }

  const candidates = tasks.filter((t) => !t.dueDate).slice(0, 50);
  if (candidates.length === 0) {
    return res.json({ suggestions: [] });
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  const today = new Date().toISOString().slice(0, 10);

  const slim = candidates.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description?.slice(0, 200),
    theme: t.theme,
  }));

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
          content: `today: ${today}\n\ntasks:\n${JSON.stringify(slim, null, 2)}`,
        },
      ],
    });

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = extractJson(raw) as { suggestions?: unknown };
    if (!parsed || !Array.isArray(parsed.suggestions)) {
      return res
        .status(502)
        .json({ error: "invalid_model_response", message: "Bad shape", raw });
    }

    res.json({ suggestions: parsed.suggestions });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    res.status(500).json({ error: "anthropic_error", message });
  }
});
