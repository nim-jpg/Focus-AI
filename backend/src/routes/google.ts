import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { google, type Auth } from "googleapis";

const TOKENS_FILE = path.resolve(process.cwd(), ".google-tokens.json");

interface StoredTokens extends Auth.Credentials {
  email?: string;
}

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

function makeClient(): Auth.OAuth2Client | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:8787/api/google/callback";
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await fs.readFile(TOKENS_FILE, "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf8");
}

async function getAuthorizedClient(): Promise<Auth.OAuth2Client | null> {
  const client = makeClient();
  if (!client) return null;
  const tokens = await loadTokens();
  if (!tokens) return null;
  client.setCredentials(tokens);
  return client;
}

export const googleRouter = Router();

googleRouter.get("/status", async (_req, res) => {
  const client = makeClient();
  if (!client) {
    res.json({ configured: false, connected: false });
    return;
  }
  const tokens = await loadTokens();
  res.json({
    configured: true,
    connected: Boolean(tokens?.access_token || tokens?.refresh_token),
    email: tokens?.email ?? null,
  });
});

googleRouter.get("/auth-url", (_req, res) => {
  const client = makeClient();
  if (!client) {
    res
      .status(400)
      .json({ error: "google_not_configured", message: "GOOGLE_CLIENT_ID/SECRET missing" });
    return;
  }
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
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
  try {
    const { tokens } = await client.getToken(code);
    // Optionally fetch the user's email so we can show it on the connected UI.
    let email: string | undefined;
    try {
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const me = await oauth2.userinfo.get();
      email = me.data.email ?? undefined;
    } catch {
      // non-fatal — we proceed without the email label
    }
    await saveTokens({ ...tokens, email });
    // Redirect back to the frontend dev server.
    const frontend = process.env.FRONTEND_URL ?? "http://localhost:5173";
    res.redirect(`${frontend}/?google=connected`);
  } catch (err) {
    res.status(500).send(
      `Google token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

googleRouter.post("/events", async (req, res) => {
  const client = await getAuthorizedClient();
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
    const stored = await loadTokens();
    if (stored && fresh.access_token && fresh.access_token !== stored.access_token) {
      await saveTokens({ ...stored, ...fresh });
    }
    res.json({ eventId: result.data.id, htmlLink: result.data.htmlLink });
  } catch (err) {
    res.status(500).json({
      error: "create_event_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

googleRouter.get("/events", async (req, res) => {
  const client = await getAuthorizedClient();
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
    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin: from,
      timeMax: to,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });
    const events = (result.data.items ?? []).map((ev) => ({
      id: ev.id,
      summary: ev.summary ?? "(no title)",
      start: ev.start?.dateTime ?? ev.start?.date ?? null,
      end: ev.end?.dateTime ?? ev.end?.date ?? null,
      allDay: Boolean(ev.start?.date && !ev.start?.dateTime),
      htmlLink: ev.htmlLink ?? null,
    }));
    res.json({ events });
  } catch (err) {
    res.status(500).json({
      error: "list_events_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

googleRouter.delete("/disconnect", async (_req, res) => {
  try {
    await fs.unlink(TOKENS_FILE);
  } catch {
    // already gone
  }
  res.json({ ok: true });
});
