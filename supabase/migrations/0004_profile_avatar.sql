-- Nagrik: profile photo the citizen picks in the app. Run in the Supabase SQL editor after 0003.

alter table public.profiles add column if not exists avatar_url text;
