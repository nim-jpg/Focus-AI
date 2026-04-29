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

// PATCH the event's time (used when the user edits the due date of an
// imported task — Focus3 syncs the change back to Google so the event
// moves with the task).
googleRouter.patch("/events/:id", async (req, res) => {
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
  const { start, end } = req.body as { start?: string; end?: string };
  if (!start || !end) {
    res.status(400).json({ error: "missing_fields", message: "start + end required" });
    return;
  }
  try {
    const calendar = google.calendar({ version: "v3", auth: client });
    const result = await calendar.events.patch({
      calendarId: "primary",
      eventId: id,
      requestBody: {
        start: { dateTime: start },
        end: { dateTime: end },
      },
    });
    res.json({ ok: true, htmlLink: result.data.htmlLink });
  } catch (err) {
    res.status(500).json({
      error: "patch_event_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

googleRouter.delete("/disconnect", async (req, res) => {
  await deleteTokens(req.userId);
  res.json({ ok: true });
});

// ─── Auto-sync from Google ────────────────────────────────────────────────
// Single round-trip that does both:
//   1. classifies upcoming events as "actionable task" vs "passive meeting"
//      via a Claude call and creates Focus3 tasks for the actionable ones
//      (linked via calendarEventId, scheduledFor empty so the time stays
//      in Google);
//   2. proposes fuller addresses for events with ambiguous locations and
//      writes back ONLY the high-confidence proposals — medium/low rows
//      are returned to the caller as "needs review" so they can use the
//      manual enrich panel without the auto-apply risk.
//
// Trust contract: the user explicitly clicked "Sync now" so the backend
// has consent for the writes. Heuristic safety on top: never auto-import
// recurring meetings, never auto-import long blocks (>4h), never auto-
// apply medium/low confidence addresses, never overwrite a non-empty
// location that already has a comma or postcode.
googleRouter.post("/auto-sync", async (req, res) => {
  console.log(
    `[auto-sync] START user=${req.userId} placesKey=${process.env.GOOGLE_PLACES_API_KEY ? "SET" : "MISSING"}`,
  );
  const client = await getAuthorizedClient(req.userId);
  if (!client) {
    console.warn("[auto-sync] no authorized client — user not connected");
    res.status(401).json({ error: "not_connected" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[auto-sync] ANTHROPIC_API_KEY missing");
    res.status(500).json({ error: "anthropic_not_configured" });
    return;
  }
  const supabase = getSupabase();
  if (!isMultiUser() || !supabase) {
    console.error("[auto-sync] supabase unavailable");
    res
      .status(503)
      .json({ error: "store_unavailable", message: "Multi-user mode required" });
    return;
  }
  const daysForward = Math.min(
    Math.max(Number(req.body?.daysForward ?? 14), 1),
    60,
  );
  // Persisted-skip list: events the user has already reviewed and
  // chosen NOT to enrich. We exclude these from the location candidate
  // set so future syncs don't surface them again.
  const skipEventIds = new Set<string>(
    Array.isArray(req.body?.skipEventIds)
      ? (req.body.skipEventIds as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [],
  );
  // Excluded calendars (mirrors prefs.excludedCalendarIds): drop these
  // out of the writable list before we even fetch events. The schedule
  // view already hides them; auto-sync should respect the same setting.
  const excludedCalendarIds = new Set<string>(
    Array.isArray(req.body?.excludedCalendarIds)
      ? (req.body.excludedCalendarIds as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [],
  );
  const from = new Date().toISOString();
  const to = new Date(
    Date.now() + daysForward * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    const calendar = google.calendar({ version: "v3", auth: client });

    // Writable calendars only — same access-role filter as the manual
    // enrichment route.
    const calList = await calendar.calendarList.list({
      maxResults: 250,
      showHidden: false,
    });
    const writable = (calList.data.items ?? []).filter(
      (c) =>
        c.id &&
        (c.accessRole === "owner" || c.accessRole === "writer") &&
        c.selected !== false &&
        !excludedCalendarIds.has(c.id),
    );
    if (excludedCalendarIds.size > 0) {
      console.log(
        `[auto-sync] excludedCalendarIds=${excludedCalendarIds.size} → ${
          (calList.data.items ?? []).length
        } total → ${writable.length} writable after exclusion`,
      );
    }

    // Pull existing Focus3 tasks for this user so we can skip events that
    // are already linked to one.
    const { data: existingTaskRows } = await supabase
      .from("tasks")
      .select("payload")
      .eq("user_id", req.userId);
    const linkedEventIds = new Set<string>();
    for (const r of existingTaskRows ?? []) {
      const ev = (r.payload as { calendarEventId?: string })?.calendarEventId;
      if (ev) linkedEventIds.add(ev);
    }

    type Ev = {
      id: string;
      calendarId: string;
      calendarName: string;
      summary: string;
      description: string;
      start: string | null;
      end: string | null;
      allDay: boolean;
      durationMinutes: number;
      isRecurring: boolean;
      location: string;
    };
    const allEvents: Ev[] = [];
    let totalScanned = 0;

    await Promise.all(
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
          for (const e of r.data.items ?? []) {
            totalScanned += 1;
            if (!e.id || !e.summary) continue;
            const startIso = e.start?.dateTime ?? e.start?.date ?? null;
            const endIso = e.end?.dateTime ?? e.end?.date ?? null;
            const allDay = Boolean(e.start?.date && !e.start?.dateTime);
            const dur =
              startIso && endIso && !allDay
                ? Math.max(
                    5,
                    Math.round(
                      (new Date(endIso).getTime() -
                        new Date(startIso).getTime()) /
                        60000,
                    ),
                  )
                : 30;
            allEvents.push({
              id: e.id,
              calendarId: cal.id!,
              calendarName: cal.summary ?? "(untitled)",
              summary: e.summary,
              description: (e.description ?? "").slice(0, 280),
              start: startIso,
              end: endIso,
              allDay,
              durationMinutes: dur,
              // Recurring tasks usually aren't task-like ("weekly standup"
              // shouldn't be tracked as a Focus3 task). We keep this flag
              // and tell Claude.
              isRecurring: Boolean(e.recurringEventId),
              location: e.location ?? "",
            });
          }
        } catch {
          /* per-calendar failure isolated */
        }
      }),
    );

    // Pre-filter: skip events already linked, OOO markers, all-day, long
    // blocks (>4h almost never task-like), AND any RECURRING event. The
    // user's direction: "events which repeat weekly… they shouldn't exist
    // in the priority list, just like working out and taking tablets".
    // Recurring meetings / weekly reviews / monthly check-ins are
    // routine, not actionable Focus3 tasks. They live on the schedule,
    // not the task list.
    const looksOOO = /\b(ooo|out of office|holiday|annual leave|vacation|pto|sick)\b/i;
    const candidates = allEvents.filter((e) => {
      if (linkedEventIds.has(e.id)) return false;
      if (e.allDay) return false;
      if (looksOOO.test(e.summary)) return false;
      if (e.durationMinutes > 4 * 60) return false;
      if (e.isRecurring) return false;
      return true;
    });

    // Filter for location enrichment: events with NO location set, where
    // the title genuinely reads like it SHOULD have a venue.
    //
    // Anything that already has a location is skipped (user direction).
    //
    // The heuristic is deliberately conservative to avoid over-suggesting
    // — we'd rather miss a few than guess venues for "Workout" or
    // "Coffee with Sam":
    //   1. Title contains a strong venue-implying word (concert, match,
    //      doctor, gym session, etc.) — events that essentially require
    //      a real-world place.
    //   2. OR title is Title-Cased multi-word (Royal Albert Hall, Grove
    //      on the Hill) — looks like a proper noun for a place.
    //   3. Description explicitly mentions a venue keyword (e.g. "at the
    //      O2", "address: ...").
    // Notably NOT triggers: bare social meal words ("lunch", "dinner",
    // "coffee", "drinks") — those are too often "lunch with X" with
    // no actionable venue clue. If they DO have a Title-Cased venue
    // attached ("Dinner at Grove on the Hill") the title heuristic
    // catches it.
    const STRONG_VENUE_HINT =
      /\b(concert|gig|show|movie|cinema|theatre|theater|performance|recital|festival|wedding|ceremony|reception|gala|matin[ée]e|opera|ballet|launch event|conference|seminar|exhibition|exhibit|tour|viewing|matin[ée]e|doctor|dentist|gp|hospital|clinic|appointment|consultation|surgery|specialist|interview|match|fixture|race|training|gym|swim|class|lesson|workshop|graduation|lunch|dinner|brunch|breakfast|supper|drinks|coffee|tea|date)\b/i;
    const DESC_VENUE_HINT =
      /\b(address|venue|location|directions|at the|at\s+[A-Z]|map link|address:)\b/;
    const looksTitleCasedVenue = (s: string): boolean => {
      const words = s.trim().split(/\s+/);
      if (words.length < 2 || words.length > 6) return false;
      // Skip if the title starts with a clearly-actionable verb.
      if (
        /^(submit|send|pay|email|call|finish|draft|write|review|prepare|sign|update|fix|deliver|file|book|schedule|set up|organise)\b/i.test(
          s,
        )
      ) {
        return false;
      }
      // Venue-like title: ≥2 capitalised words, AND every other word is
      // a small linking stopword (the / on / of / a / and / in / at /
      // by / to / for). Catches "Grove on the Hill", "Royal Albert
      // Hall", "Bank of England", "House of Lords", "Battle of Britain
      // Memorial Flight" without forcing every word to be capitalised.
      const stopwords = new Set([
        "of",
        "on",
        "the",
        "a",
        "an",
        "and",
        "or",
        "in",
        "at",
        "by",
        "to",
        "for",
        "de",
        "la",
        "le",
        "du",
      ]);
      const upperCount = words.filter((w) => /^[A-Z]/.test(w)).length;
      if (upperCount < 2) return false;
      const everyWordCapsOrStop = words.every(
        (w) => /^[A-Z]/.test(w) || stopwords.has(w.toLowerCase()),
      );
      return everyWordCapsOrStop;
    };
    const locationCandidates = allEvents.filter((e) => {
      if (e.location) return false;
      if (e.allDay) return false;
      // Honour the user's persistent Skip — they've already said "don't
      // enrich this one", we don't surface it again.
      if (skipEventIds.has(e.id)) return false;
      const title = e.summary.trim();
      if (!title) return false;
      const desc = e.description.trim();
      if (
        STRONG_VENUE_HINT.test(title) ||
        looksTitleCasedVenue(title) ||
        DESC_VENUE_HINT.test(desc)
      ) {
        return true;
      }
      return false;
    });
    console.log(
      `[auto-sync] scanned=${totalScanned} writableCalendars=${writable.length} importCandidates=${candidates.length} locationCandidates=${locationCandidates.length}`,
    );
    for (const cal of writable) {
      console.log(
        `[auto-sync] writable-calendar "${cal.summary}" accessRole=${cal.accessRole}`,
      );
    }
    // The new policy: only events with EMPTY location qualify. Dump all
    // location candidates so we can see Grove on the Hill / Louis
    // Tomlinson / etc. that we're now picking up.
    for (const ev of locationCandidates.slice(0, 30)) {
      console.log(
        `[auto-sync] location-candidate title="${ev.summary.slice(0, 60)}" cal="${ev.calendarName}" descLen=${ev.description.length}`,
      );
    }
    // For diagnostics: events with empty location that DID NOT qualify so
    // the user can see if a relevant one was missed by the heuristic.
    const skippedEmptyLoc = allEvents.filter(
      (e) => !e.location && !e.allDay && !locationCandidates.includes(e),
    );
    console.log(
      `[auto-sync] skipped-empty-location=${skippedEmptyLoc.length} (no venue hint in title/description)`,
    );
    for (const ev of skippedEmptyLoc.slice(0, 10)) {
      console.log(
        `[auto-sync] skipped title="${ev.summary.slice(0, 60)}" descLen=${ev.description.length}`,
      );
    }

    // Short-circuit: nothing to do.
    if (candidates.length === 0 && locationCandidates.length === 0) {
      console.log("[auto-sync] nothing to do — no import or location candidates");
      res.json({
        scanned: totalScanned,
        calendars: writable.length,
        imported: 0,
        enrichedAuto: 0,
        enrichmentNeedsReview: [],
      });
      return;
    }

    // Single batched Claude call. We send everything we want classified
    // OR enriched in one prompt to amortise the round-trip cost.
    const anthropic = new Anthropic({ apiKey });
    const claudePrompt = `You are helping a productivity app decide what to do with a user's upcoming Google Calendar events. Return strict JSON, no prose, no markdown.

For each event, decide TWO things:
1. isTask — true if the event represents a piece of WORK the user has to do (an action they perform: "Submit Q3 report", "Pay invoice", "Doctor appointment", "Call accountant", "Workout"). false for passive meetings the user just attends ("Team standup", "Weekly 1:1", "Lunch with Sara", "Birthday").
   - isRecurring=true events are MUCH less likely to be task-like — recurring meetings are passive, the rare exceptions are recurring chores like "Pay rent" or "Take medication". Be strict.
   - Strong signal: imperative verb in title (Submit, Send, Pay, Call, Finish, Draft, File, Book, Fix, Update, Review, Prepare, Sign) + a personal subject ("you"-shaped, not group-shaped).
2. proposedAddress — only set this when the event TEXT (title or description) names or strongly implies a SPECIFIC venue. Default to null. The user has explicitly asked us NOT to populate locations on speculation.
   - YES, propose an address when ALL of these are true:
     · The title or description contains a clear venue name OR a named performer/event/team that can only happen at a specific venue ("Louis Tomlinson concert" → tour stop venue; "Arsenal vs Spurs" → Emirates / Tottenham Hotspur Stadium; "Hamilton matinée" → Victoria Palace Theatre).
     · You can name the venue with reasonable confidence — no shrugging.
     · A reasonable person reading the title alone would think "of course this has a venue".
   - NO, return null when ANY of these apply:
     · The title is a generic activity or social meal that names a person but no venue ("Lunch with Sarah", "Coffee with Sam", "Dinner with Mum", "Drinks with the team"). The user wants to ADD the venue manually for these — the row will still appear in their review list with an empty input. Don't guess a restaurant for them.
     · The title is a workout/exercise that could happen anywhere ("Workout", "Run").
     · The title is a phone/video meeting ("Zoom with X", "Catch-up call", "1:1").
     · The title is admin/work that doesn't need a venue ("Submit report", "Pay invoice", "Email Bob").
     · The title is a person's name only ("Sarah", "Mum's birthday") with no venue.
     · You'd be GUESSING based on vibe rather than evidence in the text.
   - Confidence:
     · high — single named venue, unambiguous ("Royal Albert Hall", "Stamford Bridge", "Grove on the Hill" — there's only one famous one).
     · medium — well-known venue but multiple branches you've picked sensibly ("Costa Soho", "the O2 for that tour date"). Goes to manual review, not auto-applied.
     · low — really speculative. Almost always better to return null.

Reading the brief again so it sticks: ERR ON THE SIDE OF NULL. If you're unsure, return null. We're trying to enrich events that obviously need a venue, not to fill in addresses for everything.

Theme suggestion (only matters when isTask=true): work / projects / personal / school / fitness / finance / diet / medication / development / household.

Return: a JSON array, same order as input, each item:
{ "id": "<event id>", "isTask": <bool>, "theme": "<theme>" | null, "proposedAddress": "<addr>" | null, "confidence": "high" | "medium" | "low" }

Events:
${JSON.stringify(
  // Only fields Claude needs — minimise tokens.
  [...candidates, ...locationCandidates.filter((e) => !candidates.includes(e))].map((e) => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    durationMinutes: e.durationMinutes,
    isRecurring: e.isRecurring,
    currentLocation: e.location || null,
  })),
  null,
  2,
)}`;

    // 54 import candidates + 1 location candidate at ~80 output tokens
    // each = ~4400 tokens. Old cap was 4000 → response truncated, JSON
    // parse silently failed, no decisions made, no Places lookup ran.
    // 16k gives headroom for ~200 events; we cap candidates above at 250.
    console.log(
      `[auto-sync] calling Claude — claudeInputs=${candidates.length + locationCandidates.filter((e) => !candidates.includes(e)).length}`,
    );
    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      messages: [{ role: "user", content: claudePrompt }],
    });
    logAiUsage(req.userId, "auto_sync", completion, true);
    const block = completion.content.find((b) => b.type === "text");
    const raw = block && "text" in block ? block.text : "";
    console.log(
      `[auto-sync] Claude response stopReason=${completion.stop_reason} rawLen=${raw.length} usage=in:${completion.usage.input_tokens} out:${completion.usage.output_tokens}`,
    );
    const m = raw.match(/\[[\s\S]*\]/);
    type Decision = {
      id: string;
      isTask: boolean;
      theme: string | null;
      proposedAddress: string | null;
      confidence: "high" | "medium" | "low";
    };
    let decisions: Decision[] = [];
    try {
      decisions = m ? (JSON.parse(m[0]) as Decision[]) : [];
    } catch (err) {
      console.warn(
        `[auto-sync] Claude JSON parse failed:`,
        err instanceof Error ? err.message : err,
      );
      // Best-effort recovery: walk back to the last complete object.
      if (m) {
        const lastClose = m[0].lastIndexOf("}");
        if (lastClose > 0) {
          try {
            decisions = JSON.parse(m[0].slice(0, lastClose + 1) + "]") as Decision[];
            console.log(
              `[auto-sync] recovered ${decisions.length} decisions after truncation`,
            );
          } catch {
            decisions = [];
          }
        }
      }
    }
    console.log(
      `[auto-sync] decisions=${decisions.length} (expected ~${candidates.length + locationCandidates.length})`,
    );
    const decisionById = new Map(decisions.map((d) => [d.id, d]));

    // ── Apply: import task-like events as Focus3 tasks ───
    const VALID_THEMES = new Set([
      "work",
      "projects",
      "personal",
      "school",
      "fitness",
      "finance",
      "diet",
      "medication",
      "development",
      "household",
    ]);
    const toInsert: Array<{
      id: string;
      user_id: string;
      payload: Record<string, unknown>;
      updated_at: string;
    }> = [];
    const now = new Date().toISOString();
    let imported = 0;
    for (const ev of candidates) {
      const d = decisionById.get(ev.id);
      if (!d || !d.isTask) continue;
      const theme =
        d.theme && VALID_THEMES.has(d.theme) ? d.theme : "work";
      const taskId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const taskPayload: Record<string, unknown> = {
        id: taskId,
        title: ev.summary,
        theme,
        urgency: "normal",
        privacy: "private",
        recurrence: "none",
        isWork: theme === "work",
        isBlocker: false,
        status: "pending",
        estimatedMinutes: ev.durationMinutes,
        calendarEventId: ev.id,
        dueDate: ev.start ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
      toInsert.push({
        id: taskId,
        user_id: req.userId!,
        payload: taskPayload,
        updated_at: now,
      });
      imported += 1;
    }
    if (toInsert.length > 0) {
      const { error } = await supabase.from("tasks").insert(toInsert);
      if (error) {
        // Don't abort — return partial success so the user sees what happened.
        console.error("[auto-sync] task insert failed:", error.message);
        imported = 0;
      } else {
        for (const t of toInsert) {
          void logMetricsEvent({
            userId: req.userId,
            eventType: "calendar_event_imported",
            metadata: { theme: (t.payload as { theme: string }).theme, auto: true },
          });
        }
      }
    }

    // ── Apply: high-confidence location proposals ───
    // For each ambiguous-location event: take Claude's proposal if HIGH;
    // otherwise try Google Places (the API knows real venue names) — its
    // hit becomes the high-confidence answer. Anything still low/medium
    // falls back to manual review.
    let enrichedAuto = 0;
    const enrichmentNeedsReview: Array<{
      id: string;
      calendarId: string;
      calendarName: string;
      summary: string;
      currentLocation: string;
      proposedAddress: string | null;
      confidence: "medium" | "low";
    }> = [];
    for (const ev of locationCandidates) {
      const d = decisionById.get(ev.id);
      let chosenAddress: string | null = null;
      let chosenConfidence: "high" | "medium" | "low" = "low";
      if (d?.proposedAddress && d.confidence === "high") {
        chosenAddress = d.proposedAddress;
        chosenConfidence = "high";
      } else {
        // Places seed: prefer the original location; fall back to Claude's
        // proposal (extracted from the description). lookupPlace tries
        // multiple query shapes (title+seed, seed alone, title alone) so
        // venue names like "Grove on the Hill" resolve even when the
        // event title is unrelated.
        const placesSeed = ev.location || d?.proposedAddress || "";
        const places = placesSeed
          ? await lookupPlace(ev.summary, placesSeed)
          : null;
        if (places) {
          chosenAddress = places.address;
          chosenConfidence = places.confidence;
        } else if (d?.proposedAddress) {
          chosenAddress = d.proposedAddress;
          chosenConfidence = d.confidence;
        }
      }
      if (chosenAddress && chosenConfidence === "high") {
        try {
          await calendar.events.patch({
            calendarId: ev.calendarId,
            eventId: ev.id,
            requestBody: { location: chosenAddress },
          });
          enrichedAuto += 1;
        } catch (err) {
          console.error(
            "[auto-sync] location patch failed:",
            err instanceof Error ? err.message : err,
          );
        }
      } else {
        enrichmentNeedsReview.push({
          id: ev.id,
          calendarId: ev.calendarId,
          calendarName: ev.calendarName,
          summary: ev.summary,
          currentLocation: ev.location,
          proposedAddress: chosenAddress,
          confidence: chosenConfidence === "high" ? "medium" : chosenConfidence,
        });
      }
    }

    console.log(
      `[auto-sync] DONE imported=${imported} enrichedAuto=${enrichedAuto} needsReview=${enrichmentNeedsReview.length}`,
    );
    res.json({
      scanned: totalScanned,
      calendars: writable.length,
      imported,
      enrichedAuto,
      enrichmentNeedsReview,
    });
  } catch (err) {
    console.error(
      "[auto-sync] FAILED:",
      err instanceof Error ? err.message : err,
    );
    logAiUsage(req.userId, "auto_sync", null, false);
    res.status(500).json({
      error: "auto_sync_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
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
    // Drop instances of recurring series — those are intentional repeats
    // (e.g. an "NL Office" event the user puts on every Mon/Wed to tag
    // office days). Their identical titles aren't duplicates to clean up,
    // they're a deliberate pattern. recurringEventId is non-null for any
    // expanded single-event instance whose parent is a series.
    const events: Ev[] = (r.data.items ?? [])
      .filter((e) => e.id && e.summary)
      .filter((e) => !e.recurringEventId)
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

/**
 * Optional Google Places Text Search lookup. When GOOGLE_PLACES_API_KEY is
 * set on the backend, we hit Places before falling back to Claude — this
 * gives real, verified addresses for venues like "Grove on the Hill" that
 * Claude can only guess at. When the env var is missing, returns null and
 * the caller falls back to Claude.
 *
 * Free tier covers ~2k Text Search requests / month — plenty for an
 * occasional auto-sync run. Cost beyond that is ~$0.032 / request.
 */
async function lookupPlaceOnce(
  query: string,
  apiKey: string,
): Promise<string | null> {
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.formattedAddress,places.displayName",
      },
      body: JSON.stringify({ textQuery: query }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "(no body)");
      console.warn(
        `[places] HTTP ${r.status} query="${query}" body=${body}`.slice(0, 300),
      );
      return null;
    }
    const data = (await r.json()) as {
      places?: Array<{ formattedAddress?: string; displayName?: { text?: string } }>;
    };
    const hit = data.places?.[0]?.formattedAddress ?? null;
    console.log(
      `[places] query="${query}" → ${hit ? `"${hit}"` : "(no result)"}`,
    );
    return hit;
  } catch (err) {
    console.warn(
      `[places] error query="${query}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Try multiple query shapes against Google Places — title+location, then
 * just the location, then just the title — so a venue name like "Grove
 * on the Hill" is found even if the title is unrelated ("dinner with
 * Sarah") and confuses the search. The first non-null hit wins.
 *
 * Returns null silently if GOOGLE_PLACES_API_KEY isn't set.
 */
async function lookupPlace(
  title: string,
  locationOrSeed: string,
): Promise<{ address: string; confidence: "high" } | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn(
      `[places] SKIPPED — GOOGLE_PLACES_API_KEY not set. Title="${title.slice(0, 40)}" location="${locationOrSeed.slice(0, 40)}"`,
    );
    return null;
  }
  // Build a deduped fallback chain — short enough to bail fast, broad
  // enough to catch venue-only and title-only cases.
  const queries: string[] = [];
  const t = title.trim();
  const l = locationOrSeed.trim();
  if (t && l) queries.push(`${t} ${l}`);
  if (l) queries.push(l);
  if (t) queries.push(t);
  for (const q of new Set(queries)) {
    const hit = await lookupPlaceOnce(q, apiKey);
    if (hit) return { address: hit, confidence: "high" };
  }
  return null;
}

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
      // When location is empty but the description hints at a venue,
      // we surface the description to Claude as the lookup seed.
      // Empty otherwise.
      descriptionForLookup: string;
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
        if (!e.id || !e.summary) continue;
        const loc = e.location ?? "";
        const hasAmbiguousLocation = loc && looksAmbiguous(loc);
        // Description-fallback: when no location is set, the description
        // can still say "at Grove on the Hill" / "meet at the Italian
        // place near Camden". Truncate to keep the Claude payload small.
        const desc = (e.description ?? "").slice(0, 280).trim();
        const useDescription = !loc && desc.length > 20;
        if (!hasAmbiguousLocation && !useDescription) continue;
        candidates.push({
          id: e.id,
          calendarId,
          calendarName,
          summary: e.summary,
          start: e.start?.dateTime ?? e.start?.date ?? null,
          currentLocation: loc,
          descriptionForLookup: useDescription ? desc : "",
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
    // Don't expose calendarId to Claude — it's irrelevant noise.
    // Pass description ONLY when currentLocation is empty (the new
    // description-fallback path).
    const claudeInput = candidates.map((c) => ({
      id: c.id,
      summary: c.summary,
      currentLocation: c.currentLocation || null,
      // Trim and only include when populated — avoids letting a passive
      // event's description leak into Claude when location is set.
      descriptionHint: c.descriptionForLookup || null,
    }));
    const prompt = `You're enriching calendar events with fuller postal addresses. For each entry, propose the most-likely full address.

Two cases:
1. currentLocation is set — interpret it as a place name + use the event title as context. Examples: "Grove on the Hill", "Costa", "St Pancras", "the Italian on Camden High Street".
2. currentLocation is null but descriptionHint is present — read the description for venue clues ("meet at the Italian near the station", "back booth at Le Cafe", "address in confirmation email"). Extract the venue name + propose its full address. If the description has no venue clue, return null.

Bias toward proposing SOMETHING:
- A named business or venue → most plausible UK / common address. Confidence "medium" usually, "high" only when there's a single well-known venue with that name.
- A landmark / district / neighbourhood without a street number → representative postal address for that area at confidence "low".
- ONLY return null when there's genuinely no place to resolve (event marked "TBD", phone number, a person's name with no business attached, description that doesn't mention a venue).

If multiple branches exist (e.g. "Costa" — many), pick the one most consistent with the event title's clues; if no clue, default to the most central UK location and mark confidence "low".

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

    // Layer 2: for every candidate Claude returned with low/medium
    // confidence (or null), try Google Places Text Search. The query
    // prefers currentLocation when set; when empty, we use Claude's
    // proposed venue name as the seed (no point searching with just an
    // event title — that returns wildly off matches). If neither is
    // available, skip Places for this candidate.
    const enriched = await Promise.all(
      candidates.map(async (c) => {
        const claudeProposal = proposalById.get(c.id);
        const claudeStrong =
          claudeProposal?.address && claudeProposal.confidence === "high";
        if (claudeStrong) {
          return {
            ...c,
            proposedAddress: claudeProposal!.address,
            confidence: "high" as const,
          };
        }
        const placesSeed =
          c.currentLocation || claudeProposal?.address || "";
        const places = placesSeed
          ? await lookupPlace(c.summary, placesSeed)
          : null;
        if (places) {
          return {
            ...c,
            proposedAddress: places.address,
            confidence: places.confidence,
          };
        }
        return {
          ...c,
          proposedAddress: claudeProposal?.address ?? null,
          confidence: claudeProposal?.confidence ?? "low",
        };
      }),
    );

    res.json({
      candidates: enriched,
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
