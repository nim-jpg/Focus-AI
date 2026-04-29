import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { google, type Auth } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabase, isMultiUser } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { logAiUsage, logMetricsEvent } from "../lib/metrics.js";

const TOKENS_FILE = path.resolve(process.cwd(), ".google-tokens.json");

interface StoredTokens extends Auth.Credentials {
  email?: string;
}

// Scopes:
//  - calendar.events: read/write events on calendars
//  - calendar.readonly: list the user's calendars (for the multi-calendar
//    picker + per-calendar privacy/shadow modes)
//  - email + profile: read the user's email so the connected status shows
//    "Calendar: you@example.com" instead of "(unknown)"
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

function makeClient(): Auth.OAuth2Client | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:8787/api/google/callback";
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Read tokens for the current user. In multi-user mode tokens are keyed by
 * userId in the public.google_tokens table; in single-user mode they live in
 * a single .google-tokens.json file at cwd.
 */
async function loadTokens(userId?: string): Promise<StoredTokens | null> {
  if (isMultiUser()) {
    if (!userId) return null;
    const supabase = getSupabase();
    if (!supabase) return null;
    const { data } = await supabase
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date, scope, token_type, email")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    return {
      access_token: data.access_token ?? undefined,
      refresh_token: data.refresh_token ?? undefined,
      expiry_date: data.expiry_date ?? undefined,
      scope: data.scope ?? undefined,
      token_type: data.token_type ?? undefined,
      email: data.email ?? undefined,
    };
  }
  try {
    const raw = await fs.readFile(TOKENS_FILE, "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens, userId?: string): Promise<void> {
  if (isMultiUser()) {
    if (!userId) {
      console.error("[google] saveTokens called without userId — token discarded");
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      console.error("[google] saveTokens: supabase client unavailable");
      return;
    }
    const { error } = await supabase.from("google_tokens").upsert(
      {
        user_id: userId,
        access_token: tokens.access_token ?? null,
        refresh_token: tokens.refresh_token ?? null,
        expiry_date: tokens.expiry_date ?? null,
        scope: tokens.scope ?? null,
        token_type: tokens.token_type ?? null,
        email: tokens.email ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      console.error("[google] saveTokens upsert failed:", error.message, error.details);
      throw new Error(`saveTokens failed: ${error.message}`);
    }
    console.log(`[google] saveTokens ok for user=${userId} email=${tokens.email ?? "(unknown)"}`);
    return;
  }
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf8");
}

async function deleteTokens(userId?: string): Promise<void> {
  if (isMultiUser()) {
    if (!userId) return;
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.from("google_tokens").delete().eq("user_id", userId);
    return;
  }
  try {
    await fs.unlink(TOKENS_FILE);
  } catch {
    /* already gone */
  }
}

async function getAuthorizedClient(userId?: string): Promise<Auth.OAuth2Client | null> {
  const client = makeClient();
  if (!client) return null;
  const tokens = await loadTokens(userId);
  if (!tokens) return null;
  client.setCredentials(tokens);
  return client;
}

export const googleRouter = Router();

// Auth gate must be registered BEFORE the routes below, otherwise Express's
// stack-walk would match the route and respond before this middleware fires —
// leaving req.userId unset and silently bypassing auth.
googleRouter.use((req, res, next) => {
  if (req.path === "/callback") return next();
  return authMiddleware(req, res, next);
});

googleRouter.get("/status", async (req, res) => {
  const client = makeClient();
  if (!client) {
    res.json({ configured: false, connected: false });
    return;
  }
  const tokens = await loadTokens(req.userId);
  res.json({
    configured: true,
    connected: Boolean(tokens?.access_token || tokens?.refresh_token),
    email: tokens?.email ?? null,
  });
});

googleRouter.get("/auth-url", (req, res) => {
  const client = makeClient();
  if (!client) {
    res
      .status(400)
      .json({ error: "google_not_configured", message: "GOOGLE_CLIENT_ID/SECRET missing" });
    return;
  }
  // In multi-user mode we need to know who came back from Google. Stash userId
  // in the OAuth `state` parameter (signed by Google's CSRF token mechanism).
  console.log(
    `[google] /auth-url userId=${req.userId ?? "(none)"} multiUser=${isMultiUser()}`,
  );
  if (isMultiUser() && !req.userId) {
    res
      .status(401)
      .json({ error: "not_signed_in", message: "Sign in before connecting calendar" });
    return;
  }
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: req.userId ?? "single-user",
  });
  res.json({ url });
});

googleRouter.get("/callback", async (req, res) => {
  const client = makeClient();
  if (!client) {
    res.status(400).send("Google OAuth not configured.");
    return;
  }
  const code = req.query.code;
  if (typeof code !== "string") {
    res.status(400).send("Missing ?code= from Google.");
    return;
  }
  // Recover the userId we stashed in `state` (multi-user mode only).
  const stateUserId =
    typeof req.query.state === "string" && req.query.state !== "single-user"
      ? req.query.state
      : undefined;
  console.log(
    `[google] /callback received code=${code.slice(0, 8)}… state=${req.query.state ?? "(none)"} → userId=${stateUserId ?? "(none)"}`,
  );
  if (isMultiUser() && !stateUserId) {
    res
      .status(400)
      .send(
        "OAuth callback missing user state. Sign out, sign back in, and click Connect Calendar again.",
      );
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    let email: string | undefined;
    try {
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const me = await oauth2.userinfo.get();
      email = me.data.email ?? undefined;
    } catch {
      // non-fatal
    }
    await saveTokens({ ...tokens, email }, stateUserId);
    const frontend = process.env.FRONTEND_URL ?? "http://localhost:5173";
    res.redirect(`${frontend}/?google=connected`);
  } catch (err) {
    console.error("[google] /callback failed:", err);
    res.status(500).send(
      `Google token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

googleRouter.post("/events", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res
      .status(401)
      .json({ error: "not_connected", message: "Connect Google Calendar first" });
    return;
  }
  const { summary, description, start, end, recurrence } = req.body as {
    summary?: string;
    description?: string;
    start?: string;
    end?: string;
    /** Optional RRULE strings — e.g. ["RRULE:FREQ=WEEKLY"]. */
    recurrence?: string[];
  };
  if (!summary || !start || !end) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  try {
    const calendar = google.calendar({ version: "v3", auth: client });
    const result = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description,
        start: { dateTime: start },
        end: { dateTime: end },
        ...(Array.isArray(recurrence) && recurrence.length > 0
          ? { recurrence }
          : {}),
      },
    });
    // Persist refreshed tokens if Google rotated them.
    const fresh = client.credentials;
    const stored = await loadTokens(req.userId);
    if (stored && fresh.access_token && fresh.access_token !== stored.access_token) {
      await saveTokens({ ...stored, ...fresh }, req.userId);
    }
    res.json({ eventId: result.data.id, htmlLink: result.data.htmlLink });
  } catch (err) {
    res.status(500).json({
      error: "create_event_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

googleRouter.get("/calendars", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res.status(401).json({ error: "not_connected" });
    return;
  }
  try {
    const calendar = google.calendar({ version: "v3", auth: client });
    // Only return calendars the user has TICKED in Google Calendar's own UI.
    // Hidden / unticked calendars are noise (long-archived shares, etc.) and
    // should not appear in Focus3's settings list.
    const list = await calendar.calendarList.list({
      maxResults: 250,
      showHidden: false,
    });
    const calendars = (list.data.items ?? [])
      .filter((c) => c.id && c.selected !== false)
      .map((c) => ({
        id: c.id ?? "",
        name: c.summary ?? "",
        description: c.description ?? null,
        color: c.backgroundColor ?? null,
        primary: c.primary ?? false,
        selected: c.selected ?? true,
      }));
    res.json({ calendars });
  } catch (err) {
    res.status(500).json({
      error: "list_calendars_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

googleRouter.get("/events", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res.status(401).json({ error: "not_connected" });
    return;
  }
  const from = typeof req.query.from === "string" ? req.query.from : new Date().toISOString();
  const to =
    typeof req.query.to === "string"
      ? req.query.to
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  try {
    const calendar = google.calendar({ version: "v3", auth: client });

    // Pull only the calendars the user has TICKED in Google Calendar's own
    // UI — shared/family calendars, holidays, etc. that they've actively
    // chosen to see. Hidden or unticked subscriptions stay out.
    const list = await calendar.calendarList.list({
      maxResults: 250,
      showHidden: false,
    });
    const calendars = (list.data.items ?? []).filter(
      (c) => c.id && c.selected !== false,
    );

    // Fetch events from each calendar in parallel.
    const perCalendar = await Promise.all(
      calendars.map(async (c) => {
        try {
          const r = await calendar.events.list({
            calendarId: c.id!,
            timeMin: from,
            timeMax: to,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 50,
          });
          return { calendar: c, items: r.data.items ?? [] };
        } catch {
          // skip calendars we can't read (permission errors, etc.)
          return { calendar: c, items: [] };
        }
      }),
    );

    const events = perCalendar.flatMap(({ calendar: c, items }) =>
      items.map((ev) => ({
        id: ev.id,
        // Recurring-series id (Google's `recurringEventId`). Same value for
        // every instance of a series — used by Focus3 to mute a whole series.
        recurringEventId: ev.recurringEventId ?? null,
        summary: ev.summary ?? "(no title)",
        start: ev.start?.dateTime ?? ev.start?.date ?? null,
        end: ev.end?.dateTime ?? ev.end?.date ?? null,
        allDay: Boolean(ev.start?.date && !ev.start?.dateTime),
        htmlLink: ev.htmlLink ?? null,
        // Calendar provenance so the UI can colour / label by source
        calendarId: c.id ?? null,
        calendarName: c.summary ?? null,
        calendarColor: c.backgroundColor ?? null,
        // True if this event came from the user's primary calendar — used
        // by the Focus-only view filter on the schedule.
        calendarPrimary: c.primary ?? false,
      })),
    );

    res.json({ events });
  } catch (err) {
    res.status(500).json({
      error: "list_events_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

googleRouter.delete("/events/:id", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res.status(401).json({ error: "not_connected" });
    return;
  }
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  try {
    const calendar = google.calendar({ version: "v3", auth: client });
    await calendar.events.delete({ calendarId: "primary", eventId: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: "delete_event_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

googleRouter.delete("/disconnect", async (req, res) => {
  await deleteTokens(req.userId);
  res.json({ ok: true });
});

// ─── Duplicate-event audit ────────────────────────────────────────────────
// Scans the user's primary calendar within a window and groups events that
// share a normalized summary. Returns groups with 2+ instances so the
// frontend can offer to clean them up. Deliberately scoped to PRIMARY only
// — duplicates inside shared / family calendars are usually intentional.
googleRouter.get("/duplicates", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res.status(401).json({ error: "not_connected" });
    return;
  }
  const daysBack = Math.min(
    Math.max(Number(req.query.daysBack ?? 30), 0),
    365,
  );
  const daysForward = Math.min(
    Math.max(Number(req.query.daysForward ?? 30), 0),
    365,
  );
  const now = Date.now();
  const from = new Date(now - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now + daysForward * 24 * 60 * 60 * 1000).toISOString();
  try {
    const calendar = google.calendar({ version: "v3", auth: client });
    const r = await calendar.events.list({
      calendarId: "primary",
      timeMin: from,
      timeMax: to,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 500,
    });
    type Ev = {
      id: string;
      summary: string;
      start: string | null;
      end: string | null;
      htmlLink: string | null;
    };
    const events: Ev[] = (r.data.items ?? [])
      .filter((e) => e.id && e.summary)
      .map((e) => ({
        id: e.id!,
        summary: e.summary ?? "",
        start: e.start?.dateTime ?? e.start?.date ?? null,
        end: e.end?.dateTime ?? e.end?.date ?? null,
        htmlLink: e.htmlLink ?? null,
      }));
    // Normalise: lowercase, trim, collapse whitespace. Identical normalised
    // titles inside a 14-day rolling window count as duplicates of each
    // other. (Same title 6 months apart is more likely a recurrence the
    // user actually wants.)
    const norm = (s: string) =>
      s.toLowerCase().replace(/\s+/g, " ").trim();
    const groups: Record<string, Ev[]> = {};
    for (const ev of events) {
      const key = norm(ev.summary);
      if (!key) continue;
      (groups[key] ??= []).push(ev);
    }
    const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
    const dupGroups: Array<{ summary: string; events: Ev[] }> = [];
    for (const list of Object.values(groups)) {
      if (list.length < 2) continue;
      list.sort((a, b) => {
        const ta = a.start ? new Date(a.start).getTime() : 0;
        const tb = b.start ? new Date(b.start).getTime() : 0;
        return ta - tb;
      });
      // Walk in order; whenever the next event is within WINDOW_MS of the
      // current cluster's first, add it to the cluster.
      let cluster: Ev[] = [list[0]];
      for (let i = 1; i < list.length; i++) {
        const ev = list[i];
        const first = cluster[0];
        const dt =
          ev.start && first.start
            ? Math.abs(
                new Date(ev.start).getTime() - new Date(first.start).getTime(),
              )
            : 0;
        if (dt <= WINDOW_MS) {
          cluster.push(ev);
        } else {
          if (cluster.length >= 2) {
            dupGroups.push({ summary: cluster[0].summary, events: cluster });
          }
          cluster = [ev];
        }
      }
      if (cluster.length >= 2) {
        dupGroups.push({ summary: cluster[0].summary, events: cluster });
      }
    }
    res.json({ groups: dupGroups, scanned: events.length });
  } catch (err) {
    res.status(500).json({
      error: "duplicates_scan_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ─── Location enrichment ──────────────────────────────────────────────────
// Find upcoming events whose `location` field looks short / ambiguous and
// ask Claude to propose a fuller address. The user reviews + approves before
// any writeback. Focus3 deliberately does NOT track location locally —
// enrichment is a one-way write into Google.
//
// Scope: every calendar where the user has writer or owner access (so PATCH
// can land). Read-only / freeBusy calendars are skipped because we couldn't
// apply an update even if the user wanted one.
googleRouter.post("/enrich-locations/scan", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res.status(401).json({ error: "not_connected" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "anthropic_not_configured" });
    return;
  }
  const daysForward = Math.min(
    Math.max(Number(req.body?.daysForward ?? 14), 1),
    180,
  );
  const from = new Date().toISOString();
  const to = new Date(
    Date.now() + daysForward * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    const calendar = google.calendar({ version: "v3", auth: client });

    // Fetch the user's calendar list and keep only those we can write to.
    // Google's accessRole values: "owner" | "writer" | "reader" | "freeBusyReader".
    const calList = await calendar.calendarList.list({
      maxResults: 250,
      showHidden: false,
    });
    const writable = (calList.data.items ?? []).filter(
      (c) =>
        c.id &&
        (c.accessRole === "owner" || c.accessRole === "writer") &&
        c.selected !== false,
    );

    // Fetch events from each writable calendar in parallel. Skip per-calendar
    // failures so one broken calendar doesn't block the rest.
    const perCalendar = await Promise.all(
      writable.map(async (cal) => {
        try {
          const r = await calendar.events.list({
            calendarId: cal.id!,
            timeMin: from,
            timeMax: to,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 250,
          });
          return {
            calendarId: cal.id!,
            calendarName: cal.summary ?? "(untitled)",
            items: r.data.items ?? [],
          };
        } catch {
          return { calendarId: cal.id!, calendarName: cal.summary ?? "(untitled)", items: [] };
        }
      }),
    );

    type Candidate = {
      id: string;
      calendarId: string;
      calendarName: string;
      summary: string;
      start: string | null;
      currentLocation: string;
    };
    const POSTCODE = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/i;
    const US_ZIP = /\b\d{5}(?:-\d{4})?\b/;
    const looksAmbiguous = (loc: string): boolean => {
      const t = loc.trim();
      if (!t) return false;
      if (t.length > 80) return false; // long string → almost certainly a real address
      if (t.includes(",")) return false; // multi-part → looks like an address
      if (POSTCODE.test(t) || US_ZIP.test(t)) return false;
      // Personal references we shouldn't try to enrich.
      if (/^(home|office|my (house|place|office)|the office)$/i.test(t)) {
        return false;
      }
      return true;
    };

    let totalScanned = 0;
    const candidates: Candidate[] = [];
    for (const { calendarId, calendarName, items } of perCalendar) {
      totalScanned += items.length;
      for (const e of items) {
        if (!e.id || !e.summary || !e.location) continue;
        if (!looksAmbiguous(e.location)) continue;
        candidates.push({
          id: e.id,
          calendarId,
          calendarName,
          summary: e.summary,
          start: e.start?.dateTime ?? e.start?.date ?? null,
          currentLocation: e.location,
        });
      }
    }

    if (candidates.length === 0) {
      res.json({ candidates: [], scanned: totalScanned, calendars: writable.length });
      return;
    }

    // Single batched Claude call: ask for proposed full addresses for each
    // ambiguous location. Order is preserved by `id` (event ids are unique
    // across calendars in the same Google account).
    const anthropic = new Anthropic({ apiKey });
    // Don't expose calendarId to Claude — it's irrelevant noise; the title
    // and the location string are what matter for address lookup.
    const claudeInput = candidates.map((c) => ({
      id: c.id,
      summary: c.summary,
      currentLocation: c.currentLocation,
    }));
    const prompt = `For each of these calendar entries, propose a likely full postal address for the place named in "currentLocation". Use the event title as context. If the place is too generic to resolve confidently (e.g. "the office", "lunch spot", a person's name), return null for that entry.

Return ONLY a JSON array, same order, each item: { "id": "...", "address": "..." | null, "confidence": "high" | "medium" | "low" }.

Entries:
${JSON.stringify(claudeInput, null, 2)}`;

    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    logAiUsage(req.userId, "enrich_locations", completion, true);
    const block = completion.content.find((b) => b.type === "text");
    const raw = block && "text" in block ? block.text : "";
    const m = raw.match(/\[[\s\S]*\]/);
    let parsed: Array<{
      id: string;
      address: string | null;
      confidence: "high" | "medium" | "low";
    }> = [];
    try {
      parsed = m ? JSON.parse(m[0]) : [];
    } catch {
      parsed = [];
    }
    const proposalById = new Map(parsed.map((p) => [p.id, p]));

    res.json({
      candidates: candidates.map((c) => {
        const p = proposalById.get(c.id);
        return {
          ...c,
          proposedAddress: p?.address ?? null,
          confidence: p?.confidence ?? "low",
        };
      }),
      scanned: totalScanned,
      calendars: writable.length,
    });
  } catch (err) {
    res.status(500).json({
      error: "enrich_scan_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// Apply a batch of approved location updates back to Google. Each update
// must include the calendarId because the same eventId only resolves
// inside its source calendar — patching the wrong calendarId returns 404.
googleRouter.post("/enrich-locations/apply", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res.status(401).json({ error: "not_connected" });
    return;
  }
  const updates = req.body?.updates;
  if (
    !Array.isArray(updates) ||
    updates.some(
      (u) =>
        !u ||
        typeof u !== "object" ||
        typeof u.id !== "string" ||
        typeof u.location !== "string" ||
        typeof u.calendarId !== "string",
    )
  ) {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  const calendar = google.calendar({ version: "v3", auth: client });
  let updated = 0;
  const failures: Array<{ id: string; reason: string }> = [];
  for (const u of updates as Array<{
    id: string;
    calendarId: string;
    location: string;
  }>) {
    try {
      await calendar.events.patch({
        calendarId: u.calendarId,
        eventId: u.id,
        requestBody: { location: u.location },
      });
      updated += 1;
    } catch (err) {
      failures.push({
        id: u.id,
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  res.json({ updated, failures });
});

// Bulk delete a set of event ids from the primary calendar. Used by the
// duplicate-audit UI to clear up the events the user has marked.
googleRouter.post("/events/bulk-delete", async (req, res) => {
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    res.status(401).json({ error: "not_connected" });
    return;
  }
  const ids = req.body?.eventIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  const calendar = google.calendar({ version: "v3", auth: client });
  let deleted = 0;
  const failures: Array<{ id: string; reason: string }> = [];
  for (const id of ids as string[]) {
    try {
      await calendar.events.delete({ calendarId: "primary", eventId: id });
      deleted += 1;
    } catch (err) {
      failures.push({
        id,
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  res.json({ deleted, failures });
});
