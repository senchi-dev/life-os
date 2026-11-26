-- 004: gym tracker schema (phase 2a). Idempotent; safe to re-run. Run after 001, 002 and 003.
-- Seven owner-only tables (RLS enabled and forced, policy owner_all, anon has nothing, authenticated gets
-- exactly the four verbs), plus two nullable settings columns. Reuses public.set_updated_at() from 001.
-- Postgres 15+. Parents are created before children.

create table if not exists public.exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 60),
  muscle_group text not null check (muscle_group in ('chest','back','shoulders','biceps','triceps','quads','hamstrings','glutes','calves','core','forearms')),
  equipment text check (equipment in ('barbell','dumbbell','cable','machine','bodyweight','other')),
  how_to text not null default '' check (char_length(how_to) <= 2000),
  is_custom boolean not null default true,
  archived boolean not null default false,
  unique (user_id, name)
);

alter table public.exercises enable row level security;
alter table public.exercises force row level security;
drop policy if exists owner_all on public.exercises;
create policy owner_all on public.exercises for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.exercises from anon, public;
revoke all on public.exercises from authenticated;
grant select, insert, update, delete on public.exercises to authenticated;
drop trigger if exists exercises_set_updated_at on public.exercises;
create trigger exercises_set_updated_at before update on public.exercises
  for each row execute function public.set_updated_at();

create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 40),
  sort smallint not null default 0,
  archived boolean not null default false,
  unique (user_id, name)
);

alter table public.routines enable row level security;
alter table public.routines force row level security;
drop policy if exists owner_all on public.routines;
create policy owner_all on public.routines for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.routines from anon, public;
revoke all on public.routines from authenticated;
grant select, insert, update, delete on public.routines to authenticated;
drop trigger if exists routines_set_updated_at on public.routines;
create trigger routines_set_updated_at before update on public.routines
  for each row execute function public.set_updated_at();

create table if not exists public.routine_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id) on delete restrict,
  position smallint not null,
  target_sets smallint not null check (target_sets between 1 and 10),
  target_reps_min smallint not null check (target_reps_min between 1 and 100),
  target_reps_max smallint not null check (target_reps_max <= 100),
  check (target_reps_max >= target_reps_min)
);
create index if not exists routine_items_routine on public.routine_items (routine_id);
create index if not exists routine_items_exercise on public.routine_items (exercise_id);

alter table public.routine_items enable row level security;
alter table public.routine_items force row level security;
drop policy if exists owner_all on public.routine_items;
create policy owner_all on public.routine_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.routine_items from anon, public;
revoke all on public.routine_items from authenticated;
grant select, insert, update, delete on public.routine_items to authenticated;
drop trigger if exists routine_items_set_updated_at on public.routine_items;
create trigger routine_items_set_updated_at before update on public.routine_items
  for each row execute function public.set_updated_at();

create table if not exists public.schedule_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  weekday smallint not null check (weekday between 1 and 7),
  routine_id uuid references public.routines(id) on delete set null,
  unique (user_id, weekday)
);

alter table public.schedule_slots enable row level security;
alter table public.schedule_slots force row level security;
drop policy if exists owner_all on public.schedule_slots;
create policy owner_all on public.schedule_slots for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.schedule_slots from anon, public;
revoke all on public.schedule_slots from authenticated;
grant select, insert, update, delete on public.schedule_slots to authenticated;
drop trigger if exists schedule_slots_set_updated_at on public.schedule_slots;
create trigger schedule_slots_set_updated_at before update on public.schedule_slots
  for each row execute function public.set_updated_at();

create table if not exists public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  routine_id uuid references public.routines(id) on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  day date not null,
  started_at timestamptz not null,
  ended_at timestamptz check (ended_at is null or ended_at >= started_at),
  duration_known boolean not null default true,
  note text not null default '' check (char_length(note) <= 2000),
  imported boolean not null default false,
  source_ref text check (source_ref is null or char_length(source_ref) between 1 and 80),
  check (not imported or (source_ref is not null and ended_at is not null))
);
create unique index if not exists workouts_one_active on public.workouts (user_id) where ended_at is null;
create unique index if not exists workouts_source_ref on public.workouts (user_id, source_ref) where source_ref is not null;
create index if not exists workouts_user_started on public.workouts (user_id, started_at desc);
create index if not exists workouts_routine on public.workouts (routine_id);

alter table public.workouts enable row level security;
alter table public.workouts force row level security;
drop policy if exists owner_all on public.workouts;
create policy owner_all on public.workouts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.workouts from anon, public;
revoke all on public.workouts from authenticated;
grant select, insert, update, delete on public.workouts to authenticated;
drop trigger if exists workouts_set_updated_at on public.workouts;
create trigger workouts_set_updated_at before update on public.workouts
  for each row execute function public.set_updated_at();

create table if not exists public.workout_exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  workout_id uuid not null references public.workouts(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id) on delete restrict,
  position smallint not null,
  note text not null default '' check (char_length(note) <= 500)
);
create index if not exists workout_exercises_user_exercise on public.workout_exercises (user_id, exercise_id, created_at desc);
create index if not exists workout_exercises_workout on public.workout_exercises (workout_id);
create index if not exists workout_exercises_exercise on public.workout_exercises (exercise_id);

alter table public.workout_exercises enable row level security;
alter table public.workout_exercises force row level security;
drop policy if exists owner_all on public.workout_exercises;
create policy owner_all on public.workout_exercises for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.workout_exercises from anon, public;
revoke all on public.workout_exercises from authenticated;
grant select, insert, update, delete on public.workout_exercises to authenticated;
drop trigger if exists workout_exercises_set_updated_at on public.workout_exercises;
create trigger workout_exercises_set_updated_at before update on public.workout_exercises
  for each row execute function public.set_updated_at();

create table if not exists public.sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  workout_exercise_id uuid not null references public.workout_exercises(id) on delete cascade,
  set_no smallint not null check (set_no between 1 and 50),
  reps smallint not null check (reps between 0 and 1000),
  weight_kg numeric(6,2) not null default 0 check (weight_kg between 0 and 1000),
  type text not null default 'normal' check (type in ('normal','warmup','dropset','failure')),
  is_pr boolean not null default false,
  done_at timestamptz not null
);
create index if not exists sets_workout_exercise on public.sets (workout_exercise_id);
create index if not exists sets_user on public.sets (user_id);

alter table public.sets enable row level security;
alter table public.sets force row level security;
drop policy if exists owner_all on public.sets;
create policy owner_all on public.sets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.sets from anon, public;
revoke all on public.sets from authenticated;
grant select, insert, update, delete on public.sets to authenticated;
drop trigger if exists sets_set_updated_at on public.sets;
create trigger sets_set_updated_at before update on public.sets
  for each row execute function public.set_updated_at();

alter table public.settings add column if not exists gym_habit_id uuid references public.habits(id) on delete set null;
alter table public.settings add column if not exists gym_seeded_at timestamptz;
