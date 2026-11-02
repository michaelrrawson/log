-- Log: database setup for Supabase.
-- Anyone can read entries and photos. Only emails listed in public.admins can add, edit or delete.

-- 1. Who is allowed to edit
create table if not exists public.admins (
  email text primary key
);
alter table public.admins enable row level security;
-- No policies on admins: nobody can read or change it from the website.

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where email = lower(auth.jwt() ->> 'email'));
$$;
grant execute on function public.is_admin() to anon, authenticated;

-- 2. Entries
create table if not exists public.entries (
  id          text primary key default gen_random_uuid()::text,
  title       text not null,
  kind        text not null default 'other',
  place       text not null default '',
  start_date  date not null,
  end_date    date,
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  route       jsonb not null default '[]'::jsonb,   -- [[lat, lng], ...]
  notes       text not null default '',
  photos      jsonb not null default '[]'::jsonb,   -- [{"path": "...", "name": "..."}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.entries enable row level security;

drop policy if exists "entries are public" on public.entries;
create policy "entries are public" on public.entries for select using (true);
drop policy if exists "admins insert entries" on public.entries;
create policy "admins insert entries" on public.entries for insert with check (public.is_admin());
drop policy if exists "admins update entries" on public.entries;
create policy "admins update entries" on public.entries for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete entries" on public.entries;
create policy "admins delete entries" on public.entries for delete using (public.is_admin());

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries for each row execute function public.touch_updated_at();

-- 3. Photo storage: a public bucket, writes for admins only
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do update set public = true;

drop policy if exists "photos are public" on storage.objects;
create policy "photos are public" on storage.objects for select using (bucket_id = 'photos');
drop policy if exists "admins upload photos" on storage.objects;
create policy "admins upload photos" on storage.objects for insert with check (bucket_id = 'photos' and public.is_admin());
drop policy if exists "admins update photos" on storage.objects;
create policy "admins update photos" on storage.objects for update using (bucket_id = 'photos' and public.is_admin());
drop policy if exists "admins delete photos" on storage.objects;
create policy "admins delete photos" on storage.objects for delete using (bucket_id = 'photos' and public.is_admin());

-- 4. Editor emails (lowercase)
-- insert into public.admins (email) values ('you@example.com') on conflict do nothing;

-- 5. Added Nov 2026: gear lists, Strava stats and the Strava connection
alter table public.entries add column if not exists gear jsonb not null default '[]'::jsonb;   -- ["Speedgoat 5", ...]
alter table public.entries add column if not exists stats jsonb not null default '{}'::jsonb;  -- {strava_id, meters, vertical_m, moving_s, sport}
create table if not exists public.strava_auth (
  id int primary key default 1 check (id = 1), athlete_id bigint, access_token text, refresh_token text,
  expires_at bigint, connect_nonce text, nonce_at timestamptz, last_sync timestamptz, last_result text);
alter table public.strava_auth enable row level security;  -- no policies: server only
insert into public.strava_auth (id) values (1) on conflict do nothing;
-- strava_connect_nonce() (editors only) and strava_status() (signed in) live in the database;
-- a pg_cron job named 'strava-sync' calls the strava-sync function at :23 every 3 hours.
