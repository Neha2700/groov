-- Groov database setup.
-- Run once: Supabase dashboard → SQL Editor → New query → paste all → Run.
-- Safe to re-run: it drops and recreates only Groov's own objects.
--
-- What's stored: display names, playlists, which songs are in them (title,
-- artist, artwork link, length — never the audio), who a playlist is shared
-- with, and play history. Row-level security makes sure each person only
-- sees their own playlists and ones shared with them.

-- Clean slate (only Groov's objects) ------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.can_access_playlist(uuid) cascade;
drop function if exists public.share_playlist(uuid, text) cascade;
drop function if exists public.unshare_playlist(uuid, uuid) cascade;
drop table if exists public.play_history cascade;
drop table if exists public.app_settings cascade;
drop table if exists public.video_ids cascade;
drop table if exists public.follows cascade;
drop table if exists public.playlist_tracks cascade;
drop table if exists public.playlist_members cascade;
drop table if exists public.playlists cascade;
drop table if exists public.profiles cascade;

-- Profiles: a display name per account, created automatically on sign-up -------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Listener' check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)), 40)
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Playlists -------------------------------------------------------------------
create table public.playlists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index playlists_owner_idx on public.playlists (owner_id);

-- People a playlist is shared with (they can add and remove songs).
create table public.playlist_members (
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (playlist_id, user_id)
);
create index playlist_members_user_idx on public.playlist_members (user_id);

-- Songs in playlists. "track" is the song's info as the app shows it.
create table public.playlist_tracks (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  track_key text not null,
  track jsonb not null,
  position double precision not null default extract(epoch from now()),
  added_by uuid default auth.uid() references public.profiles (id) on delete set null,
  added_at timestamptz not null default now(),
  unique (playlist_id, track_key)
);
create index playlist_tracks_playlist_idx on public.playlist_tracks (playlist_id, position);

-- Play history, for stats and recommendations.
create table public.play_history (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  track_key text not null,
  track jsonb not null,
  played_at timestamptz not null default now()
);
create index play_history_user_idx on public.play_history (user_id, played_at desc);

-- Access rules ----------------------------------------------------------------
-- Owner or member? (security definer, so policies can call it without recursion)
create function public.can_access_playlist(pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from playlists p where p.id = pid and p.owner_id = auth.uid())
      or exists (select 1 from playlist_members m where m.playlist_id = pid and m.user_id = auth.uid());
$$;

alter table public.profiles enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_members enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.play_history enable row level security;

-- Names are visible to signed-in users (to show who shared or added a song).
create policy "read names" on public.profiles
  for select to authenticated using (true);
create policy "edit own name" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- (owner_id check inline too: the helper can't see a row mid-insert)
create policy "see own and shared playlists" on public.playlists
  for select to authenticated using (owner_id = auth.uid() or public.can_access_playlist(id));
create policy "create own playlists" on public.playlists
  for insert to authenticated with check (owner_id = auth.uid());
create policy "owner renames" on public.playlists
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner deletes" on public.playlists
  for delete to authenticated using (owner_id = auth.uid());

create policy "see members" on public.playlist_members
  for select to authenticated using (public.can_access_playlist(playlist_id));
-- Leave a shared playlist yourself, or the owner removes someone.
create policy "leave or remove" on public.playlist_members
  for delete to authenticated using (
    user_id = auth.uid()
    or exists (select 1 from public.playlists p where p.id = playlist_id and p.owner_id = auth.uid())
  );
-- (Adding members only goes through share_playlist() below.)

create policy "see songs" on public.playlist_tracks
  for select to authenticated using (public.can_access_playlist(playlist_id));
create policy "add songs" on public.playlist_tracks
  for insert to authenticated with check (public.can_access_playlist(playlist_id));
create policy "reorder songs" on public.playlist_tracks
  for update to authenticated using (public.can_access_playlist(playlist_id))
  with check (public.can_access_playlist(playlist_id));
create policy "remove songs" on public.playlist_tracks
  for delete to authenticated using (public.can_access_playlist(playlist_id));

create policy "own history" on public.play_history
  for select to authenticated using (user_id = auth.uid());
create policy "log own plays" on public.play_history
  for insert to authenticated with check (user_id = auth.uid());
create policy "clear own history" on public.play_history
  for delete to authenticated using (user_id = auth.uid());

-- Sharing ---------------------------------------------------------------------
-- Share a playlist with another Groov account by their email. Only the owner
-- can. Returns the friend's display name. Emails are never readable directly.
create function public.share_playlist(pid uuid, friend_email text) returns text
language plpgsql security definer set search_path = public as $$
declare
  friend uuid;
  friend_name text;
begin
  if not exists (select 1 from playlists where id = pid and owner_id = auth.uid()) then
    raise exception 'Only the playlist''s owner can share it';
  end if;
  select u.id into friend from auth.users u where lower(u.email) = lower(trim(friend_email));
  if friend is null then
    raise exception 'No Groov account uses that email';
  end if;
  if friend = auth.uid() then
    raise exception 'That''s your own email';
  end if;
  insert into playlist_members (playlist_id, user_id) values (pid, friend) on conflict do nothing;
  update playlists set is_shared = true, updated_at = now() where id = pid;
  select display_name into friend_name from profiles where id = friend;
  return friend_name;
end $$;

revoke all on function public.share_playlist(uuid, text) from public, anon;
grant execute on function public.share_playlist(uuid, text) to authenticated;
revoke all on function public.can_access_playlist(uuid) from public, anon;
grant execute on function public.can_access_playlist(uuid) to authenticated;

-- Live updates: tell the apps when playlists change ---------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table public.playlists, public.playlist_members, public.playlist_tracks;

select 'Groov database is ready ✓' as status;

-- Shared settings and song → video matches (also in 002_shared_key.sql) --------
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

-- Followed artists (also in 003_follows.sql) --------------------------------
create table if not exists public.follows (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  artist_key text not null,
  artist jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_key)
);

alter table public.follows enable row level security;

drop policy if exists "see own follows" on public.follows;
drop policy if exists "follow" on public.follows;
drop policy if exists "change own follows" on public.follows;
drop policy if exists "unfollow" on public.follows;
create policy "see own follows" on public.follows for select to authenticated using (user_id = auth.uid());
create policy "follow" on public.follows for insert to authenticated with check (user_id = auth.uid());
create policy "change own follows" on public.follows for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "unfollow" on public.follows for delete to authenticated using (user_id = auth.uid());
