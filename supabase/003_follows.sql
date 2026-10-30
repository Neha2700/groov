-- Groov update 1.17: run once in Supabase → SQL Editor → New query → Run.
-- Safe to run again. Artists you follow, synced to your account.
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
