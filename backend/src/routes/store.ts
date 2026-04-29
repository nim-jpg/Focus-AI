import { Router } from "express";
import { getSupabase, isMultiUser } from "../db.js";

/**
 * CRUD routes for the per-user data: tasks, goals, prefs. Mounted under
 * /api/store. The frontend's storage.ts swaps to these calls when signed in.
 *
 * Storage shape:
 *   tasks (id text pk, user_id uuid, payload jsonb, updated_at)
 *   goals (id text pk, user_id uuid, payload jsonb, updated_at)
 *   prefs (user_id uuid pk, payload jsonb, updated_at)
 *
 * The full task/goal object lives in `payload` so we don't need a migration
 * every time the Task type grows a field.
 */
export const storeRouter = Router();

function noStore(res: import("express").Response): void {
  res.status(503).json({ error: "store_unavailable" });
}

// ─── Tasks ────────────────────────────────────────────────────────────────
storeRouter.get("/tasks", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const { data, error } = await supabase
    .from("tasks")
    .select("payload")
    .eq("user_id", req.userId);
  if (error) {
    res.status(500).json({ error: "db_read_failed", message: error.message });
    return;
  }
  res.json({ tasks: (data ?? []).map((r) => r.payload) });
});

storeRouter.put("/tasks", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const tasks = (req.body?.tasks ?? []) as Array<{ id: string }>;
  if (!Array.isArray(tasks)) {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  // Replace-all semantics — the frontend sends its full local cache. Safe with
  // RLS because the rows we delete + insert are scoped to req.userId.
  const userId = req.userId!;
  await supabase.from("tasks").delete().eq("user_id", userId);
  if (tasks.length > 0) {
    const rows = tasks.map((t) => ({
      id: t.id,
      user_id: userId,
      payload: t,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from("tasks").insert(rows);
    if (error) {
      res.status(500).json({ error: "db_write_failed", message: error.message });
      return;
    }
  }
  res.json({ ok: true, count: tasks.length });
});

// ─── Goals ────────────────────────────────────────────────────────────────
storeRouter.get("/goals", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const { data, error } = await supabase
    .from("goals")
    .select("payload")
    .eq("user_id", req.userId);
  if (error) {
    res.status(500).json({ error: "db_read_failed", message: error.message });
    return;
  }
  res.json({ goals: (data ?? []).map((r) => r.payload) });
});

storeRouter.put("/goals", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const goals = (req.body?.goals ?? []) as Array<{ id: string }>;
  if (!Array.isArray(goals)) {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  const userId = req.userId!;
  await supabase.from("goals").delete().eq("user_id", userId);
  if (goals.length > 0) {
    const rows = goals.map((g) => ({
      id: g.id,
      user_id: userId,
      payload: g,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from("goals").insert(rows);
    if (error) {
      res.status(500).json({ error: "db_write_failed", message: error.message });
      return;
    }
  }
  res.json({ ok: true, count: goals.length });
});

// ─── Prefs ────────────────────────────────────────────────────────────────
storeRouter.get("/prefs", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const { data, error } = await supabase
    .from("prefs")
    .select("payload")
    .eq("user_id", req.userId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "db_read_failed", message: error.message });
    return;
  }
  res.json({ prefs: data?.payload ?? null });
});

storeRouter.put("/prefs", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const prefs = req.body?.prefs;
  if (!prefs || typeof prefs !== "object") {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  const { error } = await supabase
    .from("prefs")
    .upsert(
      {
        user_id: req.userId!,
        payload: prefs,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (error) {
    res.status(500).json({ error: "db_write_failed", message: error.message });
    return;
  }
  res.json({ ok: true });
});

// ─── AI cache (Claude rank results) ───────────────────────────────────────
// One opaque jsonb blob per user. Ported between devices so a user's last
// AI-ranked top-three appears identically wherever they sign in.
storeRouter.get("/ai-cache", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const { data, error } = await supabase
    .from("ai_cache")
    .select("payload")
    .eq("user_id", req.userId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "db_read_failed", message: error.message });
    return;
  }
  res.json({ aiCache: data?.payload ?? null });
});

storeRouter.put("/ai-cache", async (req, res) => {
  if (!isMultiUser()) return noStore(res);
  const supabase = getSupabase();
  if (!supabase) return noStore(res);
  const aiCache = req.body?.aiCache;
  if (!aiCache || typeof aiCache !== "object") {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  const { error } = await supabase.from("ai_cache").upsert(
    {
      user_id: req.userId!,
      payload: aiCache,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    res.status(500).json({ error: "db_write_failed", message: error.message });
    return;
  }
  res.json({ ok: true });
});
