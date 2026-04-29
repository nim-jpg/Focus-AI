import type { Request, Response, NextFunction } from "express";
import { getSupabase, isMultiUser } from "../db.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * If Supabase is configured, verify the bearer token and attach req.userId.
 * If not configured, pass through (single-user / dev mode).
 *
 * Health and OAuth callback routes mount BEFORE this middleware so they
 * always work without a session.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isMultiUser()) {
    return next();
  }

  const auth = req.header("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "supabase_unavailable" });
    return;
  }

  try {
    const { data, error } = await supabase.auth.getUser(match[1]);
    if (error || !data.user) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    req.userId = data.user.id;
    next();
  } catch (err) {
    res.status(500).json({
      error: "auth_check_failed",
      message: err instanceof Error ? err.message : "unknown",
    });
  }
}
