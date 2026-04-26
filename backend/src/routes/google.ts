import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { google, type Auth } from "googleapis";
import { getSupabase, isMultiUser } from "../db.js";

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
    if (!userId) return;
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.from("google_tokens").upsert(
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
  const { summary, description, start, end } = req.body as {
    summary?: string;
    description?: string;
    start?: string;
    end?: string;
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
