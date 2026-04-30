# Focus3

Anti-procrastination & life prioritization app. Helps neurodivergent and overwhelmed users surface the **three things that matter today** across seven life themes (work, fitness, finance, diet, medication, development, household, personal), with Google Calendar integration and printable weekly planner support.

This branch (`claude/focus3-app-setup-xohwm`) lays down the initial scaffold:

- **Frontend MVP** — Vite + React + TypeScript + Tailwind, localStorage-persisted task model, Tier 1–4 heuristic prioritization engine, Top Three dashboard, mode switch (Both/Work/Personal).
- **Backend stub** — Express + Anthropic SDK route at `POST /api/prioritize` that proxies to Claude when `ANTHROPIC_API_KEY` is set. Frontend currently uses its local heuristic; the backend is wired for the next iteration.
- **Now shipped** — Recurrence engine, Foundations rail (time-slotted with counter chips), Goals (6m/1y/5y/10y), Priority Matrix, Tomorrow's preview, avoidance auto-bump, snooze, Brain Dump (Claude-parsed), OCR scan-to-app (Tesseract), PDF weekly planner, Google Calendar OAuth + Schedule, AI "Suggest due dates".
- **Still on the list** — Multi-user auth, deployment configs.

## Repo layout

```
.
├── frontend/            Vite + React + Tailwind app
│   ├── src/
│   │   ├── components/  TaskForm, TaskList, TopThree, ModeSwitch, ThemeBadge
│   │   ├── lib/         storage.ts, useTasks.ts, prioritize.ts
│   │   ├── types/       task.ts (single source of truth for Task shape)
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── ...
├── backend/             Express + Anthropic SDK
│   └── src/
│       ├── server.ts
│       └── routes/prioritize.ts
└── package.json         npm workspaces root
```

## Getting started

```bash
# Install all workspaces
npm install

# Frontend (http://localhost:5173)
npm run dev:frontend

# Backend (http://localhost:8787) — optional; copy backend/.env.example → backend/.env first
npm run dev:backend
```

The frontend proxies `/api/*` to `http://localhost:8787` via Vite.

## Google Calendar setup (optional, for Schedule button)

1. Create a project at https://console.cloud.google.com/
2. APIs & Services → Library → enable **Google Calendar API**
3. APIs & Services → OAuth consent screen → External
   - **Important:** scroll to **Test users** and click **+ Add users** to add every Google email that will authorize the app (otherwise you'll hit `Error 403: access_denied` "Access blocked: app has not completed the Google verification process"). Up to 100 testers — no review needed.
4. APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:8787/api/google/callback`
5. Paste the client id + secret into `backend/.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
6. Restart the backend, click **Connect Calendar** in the app header, authorize.

The OAuth tokens are persisted to `backend/.google-tokens.json` (gitignored). Single-user, local-only — fine for the MVP.

## Companies House setup (optional, for Company Assist)

When a task title contains "<Name> Ltd / Limited / PLC / LLP", Focus3 can look up the real Companies House confirmation statement and accounts due dates instead of guessing.

1. Register at https://developer.company-information.service.gov.uk/
2. Create an **Application** (type: Live)
3. Generate an **API key** for that application
4. Paste it into `backend/.env` as `COMPANIES_HOUSE_API_KEY`
5. Restart backend. The "Company assist" section will appear under Tomorrow's preview when matching tasks exist.

## Planner round-trip (PDF + scan-back)

- **Export PDF** (header) downloads a 7-day planner with Foundations strip, per-day Top Three, weekly-due items, and printable checkboxes. Each task is stamped with a short ID (e.g. `#abc123`).
- After ticking, deferring, or annotating the printed pages, scan a photo back into the app via **"📥 Scan back a marked-up planner"** (Add tasks section). Tesseract OCRs it, Claude maps the marks back to the right tasks via the ID stamps, and you review-and-apply the updates so your task log stays accurate.

## Prioritization engine

`frontend/src/lib/prioritize.ts` implements the Tier 1–4 logic from the product spec:

1. **Tier 1 — Must do now.** Daily medication, deadlines ≤48h, critical urgency.
2. **Tier 2 — Moves you forward.** Tasks that unlock others, finance cutoffs ≤7d, fitness/learning consistency, deadlines ≤7d for >30 min tasks.
3. **Tier 3 — Balance.** Avoidance flagging when dodged ≥2 weeks and due <2 weeks.
4. **Tier 4 — Background.** Everything else.

After scoring, a theme-balance pass prevents three tasks from the same theme dominating the Top Three unless every other theme is empty.

The Claude-powered version (server-side) uses the same tier definitions and asks Claude to return strict JSON. Frontend will fall back to the local heuristic when the backend is unreachable.

## Privacy

- Tasks live in `localStorage` only by default (`focus3:tasks:v1`).
- `private` tasks must never appear in PDFs or shared views.
- `semi-private` tasks may appear in PDFs but should be redacted in the export step (not yet implemented).
- API keys live in `backend/.env` and are never sent to the client.

## Cloud deploy (Vercel + Fly.io + Supabase)

The app runs single-user on `npm run dev` with no cloud setup. To host it for
multiple testers:

### 1. Supabase (auth + Postgres)

1. Create a project at https://supabase.com (free tier is fine).
2. **Settings → API**: copy the URL, anon key, and service-role key.
3. **SQL editor**: run the schema in `docs/supabase-schema.sql` (creates the
   tasks / goals / prefs / google_tokens tables with RLS).
4. **Authentication → Email**: enable magic-link sign-in.

### 2. Backend on Fly.io

1. Install `flyctl`: https://fly.io/docs/hands-on/install-flyctl/
2. From the repo root: `fly launch --copy-config --no-deploy`
3. Set secrets:
   ```
   fly secrets set \
     ANTHROPIC_API_KEY=sk-... \
     GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
     GOOGLE_CLIENT_SECRET=... \
     COMPANIES_HOUSE_API_KEY=... \
     SUPABASE_URL=https://xxx.supabase.co \
     SUPABASE_SERVICE_ROLE_KEY=... \
     ALLOWED_ORIGINS=https://your-vercel-domain.vercel.app
   ```
4. `fly deploy`
5. Note the app URL (e.g. `https://focus3-backend.fly.dev`) — you'll need it for Vercel.

### 3. Frontend on Vercel

1. `vercel.json` is committed — Vercel auto-detects Vite.
2. Edit the rewrite `destination` in `vercel.json` to point at your Fly URL.
3. In the Vercel dashboard → **Settings → Environment Variables** set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy.

### 4. Google OAuth — production redirect URI

In the Google Cloud Console (Credentials → your OAuth client):
1. Add `https://focus3-backend.fly.dev/api/google/callback` as an authorised
   redirect URI.
2. Add every tester's Google account email under **OAuth consent screen → Test
   users** (cap is 100 while in Testing mode — fine for a beta).

See `/Users/nim/.claude/plans/on-the-longer-list-humble-hippo.md` for the full
plan and tradeoffs.

### What multi-user mode currently does (and doesn't)

Once the Supabase + Fly + Vercel setup above is complete:

**Does:**
- Each tester signs in with their own email (magic link).
- AI calls (prioritize, parse, suggest dates, scan-back) gated by a per-user
  daily budget (50 calls/day default).
- Google Calendar tokens stored per-user in Postgres — each tester connects
  and uses their own calendar.
- CORS locked down to your Vercel domain.

**Doesn't yet (follow-up work):**
- Tasks, goals, and prefs still live in each tester's browser localStorage.
  Two browsers = two data sets per tester. Use the in-app **Backup / Restore**
  feature to move data between machines.
- The backend `/api/store/{tasks,goals,prefs}` routes already exist; the
  frontend storage hooks need swapping over (planned next).
