import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { logAiUsage } from "../lib/metrics.js";

export const parseTasksRouter = Router();

const SYSTEM_PROMPT = `You parse natural-language brain dumps into structured Focus3 tasks.

For each distinct task in the input, emit a JSON object with these fields:
- title: short imperative phrase, max 80 chars
- description: optional clarifying text from the input; omit if title is self-explanatory
- theme: one of: work, projects, personal, school, fitness, finance, diet, medication, development, household
  · "work" = the user's primary income-earning activity. For an employee
    this is their day-job. For a self-employed person this is their
    business / freelance work — which may include their own Ltd company,
    development, client work, etc.
  · "projects" = side initiatives that aren't the user's primary income.
    For an employee, this includes their own company, side hustles, app
    builds, freelance gigs, personal development. For a retired person,
    any work-shaped activity (companies, dev, building things) goes here
    since they have no day-job.
  · "school" = homework, exams, school admin, parents-evening, anything
    tied to a child's education.
  · "fitness" for sports practice, training, gym sessions, runs.
  · "household" for chores, repairs, bills not tied to finance accounts, food shop.
  · "finance" for bank, tax, investments, government filings (Companies
    House confirmation statements, VAT, accounts) — but if the filing is
    clearly tied to the user's own company, use "work" (self-employed) or
    "projects" (employee / retired).
- urgency: one of: low, normal, high, critical (default normal)
- privacy: one of: private, semi-private, public (default private)
- recurrence: one of: none, daily, weekly, monthly, quarterly, yearly (default none)
- isWork: boolean (true if theme=work, else false)
- estimatedMinutes: integer 5-480 (default 30)
- dueDate: ISO 8601 date "YYYY-MM-DD" if a date is mentioned in the text; otherwise omit
- isBlocker: boolean, true only if the input clearly says it unblocks other work

Rules:
- Skip headers, commentary, motivational lines, and items already marked done.
- Don't invent themes or due dates you can't justify from the input.
- Interpret relative dates ("today", "tomorrow", "Friday", "next week", "EOM") relative to the "today" value provided in the user message.
- Lowercase theme names.
- Return tasks in input order.
- The user message may include a "user-type:" line indicating the user's
  primary occupation context (employee / self-employed / student /
  retired / other). Use it to disambiguate work-shaped tasks
  (companies, development, business filings, building things):
    · employee → those go to "projects" (the day-job is "work"; their
      own ventures are side projects).
    · self-employed → those go to "work" (their business IS the day-job).
    · retired → those go to "projects" (no day-job, so nothing is "work").
    · student → "school" is for THEIR studies, not a child's; their own
      ventures still go to "projects".

Respond with strict JSON only, no prose, no markdown fences:
{ "tasks": [ { ... }, { ... } ] }`;

interface ParseRequest {
  text?: string;
  userType?: string;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence ? fence[1]! : trimmed);
}

parseTasksRouter.post("/", async (req, res) => {
  const { text, userType } = (req.body ?? {}) as ParseRequest;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "anthropic_not_configured",
      message: "ANTHROPIC_API_KEY is not set; brain-dump parsing requires Claude.",
    });
  }

  if (typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "empty_text" });
  }
  if (text.length > 10_000) {
    return res.status(413).json({ error: "text_too_long" });
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  const today = new Date().toISOString().slice(0, 10);

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
            `today: ${today}`,
            userType ? `user-type: ${userType}` : null,
            "",
            "brain dump:",
            text,
          ]
            .filter((s) => s !== null)
            .join("\n"),
        },
      ],
    });

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    logAiUsage(req.userId, "parse_tasks", response, true);

    const parsed = extractJson(raw) as { tasks?: unknown };

    if (!parsed || !Array.isArray(parsed.tasks)) {
      return res.status(502).json({
        error: "invalid_model_response",
        message: "Model did not return the expected shape.",
        raw,
      });
    }

    res.json({ tasks: parsed.tasks });
  } catch (err) {
    logAiUsage(req.userId, "parse_tasks", null, false);
    const message = err instanceof Error ? err.message : "unknown_error";
    res.status(500).json({ error: "anthropic_error", message });
  }
});
