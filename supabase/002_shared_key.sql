-- Groov update 1.11: run once in Supabase → SQL Editor → New query → Run.
-- Safe to run again. Doesn't touch playlists or history.

-- Settings shared by everyone signed in to Groov (e.g. the YouTube key,
-- so the laptop version and friends get full songs without pasting it).
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_by uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Which YouTube video each song is, found once by any phone and reused by
-- the laptop version (saves YouTube searches, and works without a key).
create table if not exists public.video_ids (
  track_key text primary key,
  video_id text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
alter table public.video_ids enable row level security;

drop policy if exists "read settings" on public.app_settings;
drop policy if exists "add settings" on public.app_settings;
drop policy if exists "change settings" on public.app_settings;
create policy "read settings" on public.app_settings for select to authenticated using (true);
create policy "add settings" on public.app_settings for insert to authenticated with check (true);
create policy "change settings" on public.app_settings for update to authenticated using (true) with check (true);

drop policy if exists "read video ids" on public.video_ids;
drop policy if exists "add video ids" on public.video_ids;
drop policy if exists "change video ids" on public.video_ids;
create policy "read video ids" on public.video_ids for select to authenticated using (true);
create policy "add video ids" on public.video_ids for insert to authenticated with check (true);
create policy "change video ids" on public.video_ids for update to authenticated using (true) with check (true);
