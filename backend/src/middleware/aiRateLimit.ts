import type { Request, Response, NextFunction } from "express";
import { getSupabase, isMultiUser } from "../db.js";

const DAILY_BUDGET = 50;

/**
 * Per-user daily budget on AI route calls so a stuck loop or curious tester
 * can't run a £100 Anthropic bill. No-op in single-user mode.
 *
 * Tracks counts in the public.ai_usage table (date + user → count). Increments
 * on every request that passes the gate.
 */
export async function aiRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isMultiUser()) return next();
  const supabase = getSupabase();
  if (!supabase) return next();
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);

  // Read current count
  const { data, error: readErr } = await supabase
    .from("ai_usage")
    .select("call_count")
    .eq("user_id", userId)
    .eq("day", today)
    .maybeSingle();
  if (readErr) {
    res.status(500).json({ error: "rate_limit_read_failed", message: readErr.message });
    return;
  }
  const count = data?.call_count ?? 0;
  if (count >= DAILY_BUDGET) {
    res.status(429).json({
      error: "daily_ai_budget_exceeded",
      message: `Daily AI budget of ${DAILY_BUDGET} calls reached. Resets at midnight UTC.`,
    });
    return;
  }

  // Optimistic increment — happens before the underlying handler runs.
  // If a downstream Anthropic call fails the user's budget still ticks; that's
  // intentional (cost is incurred at request time, not response time).
  await supabase
    .from("ai_usage")
    .upsert(
      { user_id: userId, day: today, call_count: count + 1 },
      { onConflict: "user_id,day" },
    );

  next();
}
