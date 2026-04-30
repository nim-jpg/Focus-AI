import type { Request, Response, NextFunction } from "express";
import { getSupabase, isMultiUser } from "../db.js";
import { logMetricsEvent } from "../lib/metrics.js";

const DAILY_BUDGET = 50;

/**
 * Per-route per-user daily caps on top of the global DAILY_BUDGET. Keep
 * specific high-cost flows (full AI ranking) on a tight leash so a single
 * user can't blow through the cost ceiling by clicking "Refresh AI"
 * 50× / day. Use the path the route is mounted under as the key.
 *
 * - "/api/prioritize" — full task ranking. 2x/day; users almost never need
 *   it more than morning + evening, and each call is the most expensive
 *   feature ($0.02-0.04 a pop).
 *
 * Routes not in this map fall through to the global DAILY_BUDGET only.
 */
const PER_ROUTE_DAILY_CAPS: Record<string, number> = {
  "/api/prioritize": 2,
};

function routeKeyFor(req: Request): string | null {
  // baseUrl is the mount path (e.g. "/api/prioritize"); fall back to "" when
  // the middleware is somehow attached without a mount.
  const base = req.baseUrl ?? "";
  return base in PER_ROUTE_DAILY_CAPS ? base : null;
}

/**
 * Per-user daily budget on AI route calls so a stuck loop or curious tester
 * can't run a £100 Anthropic bill. No-op in single-user mode.
 *
 * Tracks counts in the public.ai_usage table (date + user → count). Plus a
 * per-route check via PER_ROUTE_DAILY_CAPS for routes the user has flagged
 * as high-cost (currently /api/prioritize at 2x/day).
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

  // Read current global count.
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

  // Per-route check via metrics_events table (we already log every AI call
  // with event_type=ai_<route>). Counts today's same-route calls and
  // rejects if over the cap. Free of additional schema work.
  const routeKey = routeKeyFor(req);
  if (routeKey) {
    const cap = PER_ROUTE_DAILY_CAPS[routeKey];
    const eventType = `ai_${routeKey
      .replace(/^\/api\//, "")
      .replace(/\//g, "_")
      .replace(/-/g, "_")}`;
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const { count: routeCount } = await supabase
      .from("metrics_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("event_type", eventType)
      .gte("created_at", startOfDay.toISOString());
    if ((routeCount ?? 0) >= cap) {
      void logMetricsEvent({
        userId,
        eventType: "ai_rate_limit_hit",
        metadata: { route: routeKey, cap, count: routeCount ?? 0 },
      });
      res.status(429).json({
        error: "route_daily_cap_exceeded",
        message: `This feature is capped at ${cap} call${cap === 1 ? "" : "s"} per day. Resets at midnight UTC.`,
      });
      return;
    }
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
