# Focus3 — Multi-User Deployment Runbook

This walks you from "single-user localStorage" to "shared cloud URL with email
magic-link sign-in, per-user tasks/goals/calendar tokens".

Single-user / local dev keeps working without any of this — the multi-user
path activates only when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
set on the backend and `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set
on the frontend.

## What you'll need

- A laptop with `git`, `node ≥ 20`, `npm`
- A free Supabase account: https://supabase.com
- A free Fly.io account: https://fly.io
- A free Vercel account: https://vercel.com
- Your existing Anthropic API key + Google OAuth client id/secret
- Optional: a custom domain (~£10/yr `.app`)

Total monthly cost: **£0** until you outgrow free tiers.

## 1. Supabase — create project + apply schema

1. Sign up / log in at supabase.com.
2. **New Project** → name it `focus3`, pick the closest region. Save the
   database password somewhere (you won't need it for Focus3 itself).
3. While it provisions (~2 min): **Settings → API** and copy:
   - **Project URL** → this is `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - **anon / public key** → this is `VITE_SUPABASE_ANON_KEY`
   - **service_role / secret key** → this is `SUPABASE_SERVICE_ROLE_KEY`
     (treat this like a password — server-side only)
4. **SQL Editor → New query** → paste the contents of `docs/supabase-schema.sql`
   from this repo → **Run**. Should print `Success. No rows returned`.
5. **Authentication → Providers → Email** → make sure it's enabled
   (it is by default). Magic link is on. Disable "Confirm email" if you
   want testers to skip the confirm step (optional).
6. **Authentication → URL Configuration** → set **Site URL** to your
   eventual frontend URL (you can put a placeholder like
   `https://focus3.vercel.app` for now and update after step 4).

## 2. Google OAuth — register the production redirect

1. https://console.cloud.google.com/apis/credentials → your existing
   OAuth client → **Edit**.
2. Add an **Authorized redirect URI**:
   `https://<your-fly-app-name>.fly.dev/api/google/callback`
   (or `https://api.focus3.app/api/google/callback` if you have a custom domain).
3. Save. Keep your client id / secret handy.
4. **OAuth consent screen** → **Test users** → add the email of every tester.
   Cap is 100 — fine for 5–20.

## 3. Fly.io — deploy the backend

```bash
brew install flyctl              # macOS; or see https://fly.io/docs/install
fly auth signup                  # or `fly auth login` if you already have an account
cd ~/Projects/Focus-AI
fly launch --no-deploy           # accepts the existing fly.toml
```

When prompted:
- App name: `focus3-api` (or anything; remember it for the Google redirect URI)
- Region: closest to your testers
- Postgres: **No** (we use Supabase)
- Redis: **No**
- Deploy now: **No**

Set secrets (these don't go in fly.toml):

```bash
fly secrets set \
  ANTHROPIC_API_KEY="sk-ant-..." \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GOOGLE_REDIRECT_URI="https://focus3-api.fly.dev/api/google/callback" \
  COMPANIES_HOUSE_API_KEY="..." \
  SUPABASE_URL="https://xxxx.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  FRONTEND_URL="https://focus3.vercel.app" \
  ALLOWED_ORIGINS="https://focus3.vercel.app"
```

Deploy:

```bash
fly deploy
```

Verify:

```bash
curl https://focus3-api.fly.dev/api/health
# → {"status":"ok","service":"focus3-backend","multiUser":true}
```

If `multiUser: false`, the Supabase env vars didn't reach the container —
check `fly secrets list`.

## 4. Vercel — deploy the frontend

In the repo root:

```bash
npm i -g vercel        # if you don't already have it
vercel login
vercel link            # picks up vercel.json
```

Set env vars in the Vercel dashboard (Settings → Environment Variables) for
**Production** AND **Preview**:

- `VITE_API_BASE_URL` → `https://focus3-api.fly.dev`
- `VITE_SUPABASE_URL` → from step 1
- `VITE_SUPABASE_ANON_KEY` → from step 1

Then:

```bash
vercel --prod
```

Vercel will give you a URL like `https://focus3-abcd.vercel.app`. Open it.

## 5. Patch the auth redirect

Now that you know your real frontend URL:

- **Supabase** → Authentication → URL Configuration → set **Site URL** to
  `https://focus3.vercel.app` (whatever Vercel gave you).
- **Add Redirect URLs**: same value plus `/`.
- **Backend** (`fly secrets set FRONTEND_URL=... ALLOWED_ORIGINS=...`) → match.

## 6. Smoke test with two accounts

1. Open the Vercel URL. You should see the **Sign in** screen.
2. Enter your email → check inbox → click the magic link → land back in
   Focus3 signed in.
3. Add a task. Open Settings → I am… → enter your name. Connect Google
   Calendar. Verify it works.
4. Open a private/incognito window → same URL. Sign in as a second tester
   email. You should see an EMPTY task list (not the first user's). Connect
   their Google Calendar — different account from yours.

If both accounts share data, double-check Supabase RLS policies are active
(SQL Editor: `select tablename, policyname from pg_policies where schemaname = 'public';` should show 6 rows).

## 7. Optional — custom domain

If you bought e.g. `focus3.app`:
- Vercel: **Settings → Domains** → add `focus3.app` and `www.focus3.app`.
- Fly.io: `fly certs add api.focus3.app` and add the DNS records Fly tells you.
- Update Google OAuth redirect URI, `GOOGLE_REDIRECT_URI`, `FRONTEND_URL`,
  `ALLOWED_ORIGINS`, Supabase Site URL all to use the custom domain.

## Reverting to single-user mode

Set `SUPABASE_URL` blank on the backend (or stop the Fly app entirely) and
clear `VITE_SUPABASE_URL` from Vercel. The frontend falls back to localStorage
automatically — `isAuthEnabled()` returns false, so the auth gate is skipped
and storage uses the unscoped keys.

## Cost ceiling check

- Supabase free: 50k MAU, 500MB DB, 5GB egress/mo. You'll never hit this.
- Fly.io free hobby: 3 small VMs, 3GB volume, 160GB egress. One small VM
  for Focus3-api is plenty.
- Vercel hobby: 100GB bandwidth, fine for static SPA.
- Anthropic: pay-per-use, ~£15-25/month at your scale (capped per-user
  at 50 AI calls/day by built-in rate limit).
- Domain: £10-15/yr.

If you outgrow Fly free tier (very unlikely): `fly scale memory 512` is
about $5/month.
