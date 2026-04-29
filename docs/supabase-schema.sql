-- Focus3 Supabase schema. Paste into the Supabase SQL editor and run once.
-- Idempotent: safe to re-run during early development.

-- ─── Extensions ────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── Tasks ────────────────────────────────────────────────────────────────
create table if not exists public.tasks (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists tasks_user_idx on public.tasks(user_id);

alter table public.tasks enable row level security;

drop policy if exists tasks_owner_select on public.tasks;
drop policy if exists tasks_owner_modify on public.tasks;

create policy tasks_owner_select on public.tasks
  for select using (auth.uid() = user_id);
create policy tasks_owner_modify on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─── Goals ────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists goals_user_idx on public.goals(user_id);

alter table public.goals enable row level security;

drop policy if exists goals_owner_select on public.goals;
drop policy if exists goals_owner_modify on public.goals;

create policy goals_owner_select on public.goals
  for select using (auth.uid() = user_id);
create policy goals_owner_modify on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─── Prefs (one row per user) ─────────────────────────────────────────────
create table if not exists public.prefs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.prefs enable row level security;

drop policy if exists prefs_owner_select on public.prefs;
drop policy if exists prefs_owner_modify on public.prefs;

create policy prefs_owner_select on public.prefs
  for select using (auth.uid() = user_id);
create policy prefs_owner_modify on public.prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─── Google Calendar tokens (per user) ────────────────────────────────────
create table if not exists public.google_tokens (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  access_token   text,
  refresh_token  text,
  expiry_date    bigint,
  scope          text,
  token_type     text,
  email          text,
  updated_at     timestamptz not null default now()
);

alter table public.google_tokens enable row level security;

-- Service-role only — the backend writes/reads tokens on behalf of the user.
-- No client-facing select/insert policies; the anon key can't see this table.

-- ─── AI usage (rate limiting) ─────────────────────────────────────────────
create table if not exists public.ai_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  call_count  integer not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;
-- service-role only, no client policies.

-- ─── AI cache (Claude rank results, ported between devices) ───────────────
create table if not exists public.ai_cache (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.ai_cache enable row level security;
-- Service-role only — backend reads/writes on behalf of the signed-in user.
