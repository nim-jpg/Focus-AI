import { Router } from "express";
import { getSupabase, isMultiUser } from "../db.js";
import { logMetricsEvent } from "../lib/metrics.js";

export const metricsRouter = Router();

/**
 * Whitelist of event types the frontend is allowed to log. Hardcoding the set
 * here prevents the frontend from polluting the table with arbitrary strings,
 * and keeps the schema readable for the admin dashboard.
 */
const ALLOWED_EVENT_TYPES = new Set([
  // Task lifecycle (counts, no titles).
  "task_created",
  "task_completed",
  "task_deleted",
  "task_uncompleted",
  // Goals.
  "goal_created",
  "goal_deleted",
  // Calendar push (Focus3 → Google).
  "calendar_event_pushed",
  "calendar_event_unscheduled",
  // Calendar import (Google → Focus3).
  "calendar_event_imported",
  // Backups.
  "backup_exported",
  "backup_imported",
  // Auth.
  "session_signed_in",
]);

metricsRouter.post("/event", async (req, res) => {
  const { eventType, metadata } = (req.body ?? {}) as {
    eventType?: unknown;
    metadata?: unknown;
  };
  if (typeof eventType !== "string" || !ALLOWED_EVENT_TYPES.has(eventType)) {
    res.status(400).json({ error: "unknown_event_type" });
    return;
  }
  const cleanMetadata =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, string | number | boolean | null>)
      : undefined;
  await logMetricsEvent({
    userId: req.userId,
    eventType,
    metadata: cleanMetadata,
  });
  res.json({ ok: true });
});

/**
 * Admin dashboard. Returns aggregate stats per user (anonymised by user_id —
 * no email or content) plus token-cost totals and a per-event-type breakdown.
 *
 * Auth: gated to ADMIN_EMAILS env var (comma-separated). Empty = no admin
 * access. The auth middleware sets req.userId; we look up the email here and
 * match against the allowlist.
 */
metricsRouter.get("/admin", async (req, res) => {
  if (!isMultiUser()) {
    res.status(503).json({ error: "metrics_unavailable" });
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "supabase_unavailable" });
    return;
  }
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) {
    res.status(403).json({ error: "admin_disabled" });
    return;
  }
  // Look up the caller's email via the service-role admin API.
  const userResult = await supabase.auth.admin.getUserById(req.userId!);
  const callerEmail = userResult.data.user?.email?.toLowerCase();
  if (!callerEmail || !adminEmails.includes(callerEmail)) {
    res.status(403).json({ error: "not_admin" });
    return;
  }

  const daysBack = Math.min(
    Math.max(Number(req.query.daysBack ?? 30), 1),
    365,
  );
  const from = new Date(
    Date.now() - daysBack * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Pull raw events. With a few users + months of data this fits in a single
  // query; revisit if it grows past ~100k rows.
  const { data: events, error } = await supabase
    .from("metrics_events")
    .select(
      "user_id, event_type, model, input_tokens, output_tokens, created_at",
    )
    .gte("created_at", from)
    .order("created_at", { ascending: false })
    .limit(50000);
  if (error) {
    res.status(500).json({ error: "query_failed", message: error.message });
    return;
  }

  // Aggregate. Per-user: counts by event type + token totals. Global: same.
  type PerUser = {
    userId: string;
    counts: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  const byUser = new Map<string, PerUser>();
  const globalCounts: Record<string, number> = {};
  let globalInput = 0;
  let globalOutput = 0;

  for (const e of events ?? []) {
    const u =
      byUser.get(e.user_id) ??
      ({
        userId: e.user_id,
        counts: {},
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      } as PerUser);
    u.counts[e.event_type] = (u.counts[e.event_type] ?? 0) + 1;
    if (typeof e.input_tokens === "number") {
      u.inputTokens += e.input_tokens;
      globalInput += e.input_tokens;
    }
    if (typeof e.output_tokens === "number") {
      u.outputTokens += e.output_tokens;
      globalOutput += e.output_tokens;
    }
    globalCounts[e.event_type] = (globalCounts[e.event_type] ?? 0) + 1;
    byUser.set(e.user_id, u);
  }
  // Cost estimate: blended Claude pricing. Sonnet 4.6 ≈ $3/M input, $15/M
  // output; Opus is a bit higher. We use Sonnet pricing as the default since
  // most routes hit it; calling it "estimated" because the real number lives
  // in Anthropic's billing.
  const pricePerInputUsd = 3 / 1_000_000;
  const pricePerOutputUsd = 15 / 1_000_000;
  for (const u of byUser.values()) {
    u.estimatedCostUsd =
      u.inputTokens * pricePerInputUsd + u.outputTokens * pricePerOutputUsd;
  }
  const globalCostUsd =
    globalInput * pricePerInputUsd + globalOutput * pricePerOutputUsd;

  res.json({
    windowDays: daysBack,
    totalEvents: events?.length ?? 0,
    totalUsers: byUser.size,
    global: {
      counts: globalCounts,
      inputTokens: globalInput,
      outputTokens: globalOutput,
      estimatedCostUsd: globalCostUsd,
    },
    perUser: Array.from(byUser.values()).sort(
      (a, b) => b.estimatedCostUsd - a.estimatedCostUsd,
    ),
  });
});

/**
 * Per-user "my own usage" — same shape as admin but only the caller's data.
 * This lets every user see their own cost transparency without exposing other
 * users' numbers. Handy for the future if you ship a self-serve usage page.
 */
metricsRouter.get("/me", async (req, res) => {
  if (!isMultiUser()) {
    res.status(503).json({ error: "metrics_unavailable" });
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "supabase_unavailable" });
    return;
  }
  const daysBack = Math.min(
    Math.max(Number(req.query.daysBack ?? 30), 1),
    365,
  );
  const from = new Date(
    Date.now() - daysBack * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: events, error } = await supabase
    .from("metrics_events")
    .select("event_type, model, input_tokens, output_tokens, created_at")
    .eq("user_id", req.userId)
    .gte("created_at", from)
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) {
    res.status(500).json({ error: "query_failed", message: error.message });
    return;
  }
  const counts: Record<string, number> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of events ?? []) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    if (typeof e.input_tokens === "number") inputTokens += e.input_tokens;
    if (typeof e.output_tokens === "number") outputTokens += e.output_tokens;
  }
  const estimatedCostUsd =
    (inputTokens * 3) / 1_000_000 + (outputTokens * 15) / 1_000_000;
  res.json({
    windowDays: daysBack,
    totalEvents: events?.length ?? 0,
    counts,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
  });
});
