-- Nagrik: "Me too" supporters + nearby lookups
-- Run in the Supabase SQL editor after 0001.

alter table public.complaints add column if not exists supporters_count int not null default 0;

create table if not exists public.complaint_supporters (
  complaint_id uuid not null references public.complaints (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (complaint_id, user_id)
);
create index if not exists supporters_user_idx on public.complaint_supporters (user_id);

-- Bounding-box lookups for the Nearby map and duplicate detection.
create index if not exists complaints_geo_idx on public.complaints (latitude, longitude);

alter table public.complaint_supporters enable row level security;
drop policy if exists "own supports read" on public.complaint_supporters;
create policy "own supports read" on public.complaint_supporters for select using (auth.uid() = user_id);
-- Writes go through the backend (service role).
