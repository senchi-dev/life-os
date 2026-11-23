-- Life OS v1 schema. Paste into the Supabase SQL editor and run once.
-- Postgres 15+. Policies are owner-only; anon has no access anywhere.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  water_target_l numeric(4,2) not null default 2.5 check (water_target_l > 0),
  weekly_pages int not null default 200 check (weekly_pages >= 0),
  timezone text,
  unique (user_id)
);
create trigger settings_set_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

create table public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 40),
  schedule_kind text not null check (schedule_kind in ('daily','weekdays','n_per_week')),
  weekdays smallint[],
  target_n smallint check (target_n between 1 and 7),
  active boolean not null default true,
  sort smallint not null default 0,
  check ((schedule_kind = 'weekdays') = (weekdays is not null and cardinality(weekdays) > 0)),
  check ((schedule_kind = 'n_per_week') = (target_n is not null))
);
create trigger habits_set_updated_at before update on public.habits
  for each row execute function public.set_updated_at();

create table public.habit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  habit_id uuid not null references public.habits(id) on delete cascade,
  date date not null,
  status text not null check (status in ('done','skipped')),
  unique (habit_id, date)
);
create trigger habit_logs_set_updated_at before update on public.habit_logs
  for each row execute function public.set_updated_at();

create table public.rituals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  weekday smallint not null check (weekday between 1 and 7),
  time time not null,
  checklist jsonb not null default '[]',
  unique (user_id, name)
);
create trigger rituals_set_updated_at before update on public.rituals
  for each row execute function public.set_updated_at();

create table public.ritual_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ritual_id uuid not null references public.rituals(id) on delete cascade,
  week_start date not null,
  done_at timestamptz,
  checklist_state jsonb not null default '[]',
  unique (ritual_id, week_start)
);
create trigger ritual_logs_set_updated_at before update on public.ritual_logs
  for each row execute function public.set_updated_at();

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null check (char_length(title) between 1 and 80),
  date date not null,
  start_time time,
  end_time time,
  location text,
  check (end_time is null or start_time is null or end_time > start_time)
);
create trigger events_set_updated_at before update on public.events
  for each row execute function public.set_updated_at();

create table public.sleep (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  night_of date not null,
  bed_at timestamptz not null,
  wake_at timestamptz not null,
  minutes int generated always as ((extract(epoch from (wake_at - bed_at)) / 60)::int) stored,
  check (wake_at > bed_at and wake_at - bed_at <= interval '20 hours'),
  unique (user_id, night_of)
);
create trigger sleep_set_updated_at before update on public.sleep
  for each row execute function public.set_updated_at();

create table public.water (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  at timestamptz not null default now(),
  liters numeric(4,2) not null check (liters > 0 and liters <= 3)
);
create trigger water_set_updated_at before update on public.water
  for each row execute function public.set_updated_at();

create table public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,
  author text,
  total_pages int check (total_pages > 0),
  started_on date,
  finished_on date
);
create trigger books_set_updated_at before update on public.books
  for each row execute function public.set_updated_at();

create table public.daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  date date not null,
  mood smallint check (mood between 1 and 5),
  pages int not null default 0 check (pages >= 0),
  book_id uuid references public.books(id) on delete set null,
  unique (user_id, date)
);
create trigger daily_set_updated_at before update on public.daily
  for each row execute function public.set_updated_at();

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  week_start date not null,
  went_right text,
  went_wrong text,
  one_change text,
  change_kept boolean,
  unique (user_id, week_start)
);
create trigger reviews_set_updated_at before update on public.reviews
  for each row execute function public.set_updated_at();

create index water_user_at_idx on public.water (user_id, at);

-- Security

alter table public.settings enable row level security;
alter table public.settings force row level security;
create policy owner_all on public.settings for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.settings from anon, public;
grant select, insert, update, delete on public.settings to authenticated;

alter table public.habits enable row level security;
alter table public.habits force row level security;
create policy owner_all on public.habits for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.habits from anon, public;
grant select, insert, update, delete on public.habits to authenticated;

alter table public.habit_logs enable row level security;
alter table public.habit_logs force row level security;
create policy owner_all on public.habit_logs for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.habit_logs from anon, public;
grant select, insert, update, delete on public.habit_logs to authenticated;

alter table public.rituals enable row level security;
alter table public.rituals force row level security;
create policy owner_all on public.rituals for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.rituals from anon, public;
grant select, insert, update, delete on public.rituals to authenticated;

alter table public.ritual_logs enable row level security;
alter table public.ritual_logs force row level security;
create policy owner_all on public.ritual_logs for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.ritual_logs from anon, public;
grant select, insert, update, delete on public.ritual_logs to authenticated;

alter table public.events enable row level security;
alter table public.events force row level security;
create policy owner_all on public.events for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.events from anon, public;
grant select, insert, update, delete on public.events to authenticated;

alter table public.sleep enable row level security;
alter table public.sleep force row level security;
create policy owner_all on public.sleep for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.sleep from anon, public;
grant select, insert, update, delete on public.sleep to authenticated;

alter table public.water enable row level security;
alter table public.water force row level security;
create policy owner_all on public.water for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.water from anon, public;
grant select, insert, update, delete on public.water to authenticated;

alter table public.daily enable row level security;
alter table public.daily force row level security;
create policy owner_all on public.daily for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.daily from anon, public;
grant select, insert, update, delete on public.daily to authenticated;

alter table public.books enable row level security;
alter table public.books force row level security;
create policy owner_all on public.books for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.books from anon, public;
grant select, insert, update, delete on public.books to authenticated;

alter table public.reviews enable row level security;
alter table public.reviews force row level security;
create policy owner_all on public.reviews for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.reviews from anon, public;
grant select, insert, update, delete on public.reviews to authenticated;

alter default privileges in schema public revoke all on tables from anon;
revoke execute on function public.set_updated_at() from anon, public;
