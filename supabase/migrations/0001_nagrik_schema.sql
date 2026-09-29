-- Nagrik — agentic civic complaint system
-- Run in the Supabase SQL editor (or `supabase db push`).
-- Seed jurisdiction rows are upserted by the backend on boot (backend/src/db/seed.ts),
-- because the sandbox portal URL depends on PUBLIC_BASE_URL.

create extension if not exists "pgcrypto";

-- ───────────────────────────── profiles ─────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  email text,
  expo_push_token text,
  preferred_language text not null default 'en',
  auto_submit_default boolean not null default true,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────────────────────── jurisdiction_lookup ─────────────────────────
create table if not exists public.jurisdiction_lookup (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  state text not null,
  issue_type text not null check (issue_type in ('pothole','streetlight','garbage','water_leakage','drainage','other')),
  department_name text not null,
  portal_url text not null,
  form_selectors jsonb,                 -- Playwright field mapping for THIS portal's form
  status_check_url_template text,
  status_check_selectors jsonb,
  escalation_contact jsonb not null default '[]'::jsonb,  -- [{level,title,channel,contact,verified}]
  requires_captcha boolean not null default false,
  notes text,
  review_status text not null default 'pending' check (review_status in ('approved','pending','rejected')),
  is_sandbox boolean not null default false,
  source_urls text[] not null default '{}',
  proposed_by text,
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz not null default now()
);
create index if not exists jurisdiction_lookup_match_idx
  on public.jurisdiction_lookup (issue_type, is_sandbox, review_status, lower(city));

-- ───────────────────────────── complaints ─────────────────────────────
create table if not exists public.complaints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  photo_url text,
  issue_type text check (issue_type in ('pothole','streetlight','garbage','water_leakage','drainage','other')),
  description text,
  user_note text,
  severity text check (severity in ('low','medium','high')),
  latitude double precision,
  longitude double precision,
  address text,
  city text,
  state text,
  pincode text,
  jurisdiction_department text,
  jurisdiction_portal_id uuid references public.jurisdiction_lookup (id),
  draft_text text,
  draft_subject text,
  status text not null default 'analyzing'
    check (status in ('analyzing','drafted','submitting','submitted','submission_failed','escalated','resolved')),
  failure_reason text,
  tracking_id text,
  portal_status text,
  auto_submit boolean not null default true,
  submit_after timestamptz,
  submitted_at timestamptz,
  last_checked_at timestamptz,
  escalation_level int not null default 0,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists complaints_user_idx on public.complaints (user_id, created_at desc);
create index if not exists complaints_status_idx on public.complaints (status);

-- ─────────────────────── complaint_status_checks ───────────────────────
create table if not exists public.complaint_status_checks (
  id uuid primary key default gen_random_uuid(),
  complaint_id uuid not null references public.complaints (id) on delete cascade,
  checked_at timestamptz not null default now(),
  status_found text not null,
  source text not null check (source in ('scraped','user_reported')),
  raw_snapshot text
);
create index if not exists status_checks_complaint_idx on public.complaint_status_checks (complaint_id, checked_at desc);

-- ─────────────────────── complaint_escalations ───────────────────────
create table if not exists public.complaint_escalations (
  id uuid primary key default gen_random_uuid(),
  complaint_id uuid not null references public.complaints (id) on delete cascade,
  escalation_level int not null,
  action_taken text not null,
  channel text,
  recipient text,
  draft_text text,
  delivery_status text not null default 'manual_required'
    check (delivery_status in ('sent','manual_required','blocked_unverified','failed')),
  created_at timestamptz not null default now()
);

-- ───────────────────────── agent_tool_logs ─────────────────────────
create table if not exists public.agent_tool_logs (
  id uuid primary key default gen_random_uuid(),
  agent_name text not null,
  -- No FK: intake logs are written before the complaint row exists (and for abandoned intakes).
  complaint_id uuid,
  tool_name text not null,
  arguments jsonb,
  result jsonb,
  duration_ms int,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists tool_logs_complaint_idx on public.agent_tool_logs (complaint_id, created_at desc);
create index if not exists tool_logs_tool_idx on public.agent_tool_logs (tool_name, created_at desc);

-- ───────────────────────── notifications ─────────────────────────
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  complaint_id uuid references public.complaints (id) on delete cascade,
  title text not null,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ───────────────────────────── RLS ─────────────────────────────
alter table public.profiles enable row level security;
alter table public.complaints enable row level security;
alter table public.jurisdiction_lookup enable row level security;
alter table public.complaint_status_checks enable row level security;
alter table public.complaint_escalations enable row level security;
alter table public.agent_tool_logs enable row level security;
alter table public.notifications enable row level security;

-- Users see and edit only their own profile.
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select using (auth.uid() = id);
drop policy if exists "own profile write" on public.profiles;
create policy "own profile write" on public.profiles for update using (auth.uid() = id);
drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);

-- Users see only their own complaints. Writes go through the backend (service role),
-- which is where every agent runs and every tool call is logged.
drop policy if exists "own complaints read" on public.complaints;
create policy "own complaints read" on public.complaints for select using (auth.uid() = user_id);

drop policy if exists "own status checks read" on public.complaint_status_checks;
create policy "own status checks read" on public.complaint_status_checks for select
  using (exists (select 1 from public.complaints c where c.id = complaint_id and c.user_id = auth.uid()));

drop policy if exists "own escalations read" on public.complaint_escalations;
create policy "own escalations read" on public.complaint_escalations for select
  using (exists (select 1 from public.complaints c where c.id = complaint_id and c.user_id = auth.uid()));

drop policy if exists "own notifications read" on public.notifications;
create policy "own notifications read" on public.notifications for select using (auth.uid() = user_id);

-- Jurisdiction table: readable by every authenticated user; NO client write policy.
-- Writes happen only through the admin-reviewed backend path (POST /admin/jurisdiction/review)
-- or as agent proposals that land with review_status = 'pending'.
drop policy if exists "jurisdiction read" on public.jurisdiction_lookup;
create policy "jurisdiction read" on public.jurisdiction_lookup for select to authenticated using (true);

-- agent_tool_logs: no client policies at all (service role only).

-- ───────────────────────── storage bucket ─────────────────────────
insert into storage.buckets (id, name, public)
values ('complaint-photos', 'complaint-photos', true)
on conflict (id) do nothing;

-- Auto-create a profile row on signup.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
