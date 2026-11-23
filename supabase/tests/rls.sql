-- Life OS RLS proof. Run in the Supabase SQL editor (as postgres) AFTER 001, 002 and 003 (all three migrations:
-- the grant assertion below only passes once 003_tighten_grants.sql has been applied).
-- Everything is rolled back. Success = a single row: RLS OK. Any failure raises 'FAIL: ...'.
begin;

-- Two users. A = 00000000-0000-0000-0000-00000000000a, B = 00000000-0000-0000-0000-00000000000b
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'rls-a@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'rls-b@example.test', 'authenticated', 'authenticated');

-- One row per table for user A (as postgres, bypasses RLS)
insert into public.settings (user_id) values ('00000000-0000-0000-0000-00000000000a');
insert into public.habits (id, user_id, name, schedule_kind) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Read', 'daily');
insert into public.habit_logs (user_id, habit_id, date, status) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '2026-01-05', 'done');
insert into public.rituals (id, user_id, name, weekday, time) values
  ('20000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Weekly plan', 7, '18:00');
insert into public.ritual_logs (user_id, ritual_id, week_start) values
  ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', '2026-01-05');
insert into public.events (user_id, title, date) values
  ('00000000-0000-0000-0000-00000000000a', 'Dentist', '2026-01-06');
insert into public.sleep (user_id, night_of, bed_at, wake_at) values
  ('00000000-0000-0000-0000-00000000000a', '2026-01-05', '2026-01-05 22:30+00', '2026-01-06 06:30+00');
insert into public.water (user_id, liters) values
  ('00000000-0000-0000-0000-00000000000a', 0.5);
insert into public.books (id, user_id, title) values
  ('30000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Book A');
insert into public.daily (user_id, date, mood, pages, book_id) values
  ('00000000-0000-0000-0000-00000000000a', '2026-01-05', 3, 10, '30000000-0000-0000-0000-00000000000a');
insert into public.reviews (user_id, week_start) values
  ('00000000-0000-0000-0000-00000000000a', '2026-01-05');

-- Act as user B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}';

-- 1. B sees nothing
do $$
declare t text; n bigint;
begin
  foreach t in array array['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','daily','books','reviews'] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then raise exception 'FAIL: % B can see % rows of A', t, n; end if;
  end loop;
end $$;

-- 2. B cannot update or delete A's rows
do $$
declare t text; n bigint;
begin
  foreach t in array array['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','daily','books','reviews'] loop
    execute format('update public.%I set updated_at = now()', t);
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: % B updated % rows of A', t, n; end if;
    execute format('delete from public.%I', t);
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: % B deleted % rows of A', t, n; end if;
  end loop;
end $$;

-- 3. B cannot insert rows owned by A (RLS with-check, SQLSTATE 42501)
do $$
declare
  stmts text[] := array[
    $q$insert into public.settings (user_id) values ('00000000-0000-0000-0000-00000000000a')$q$,
    $q$insert into public.habits (user_id, name, schedule_kind) values ('00000000-0000-0000-0000-00000000000a', 'X', 'daily')$q$,
    $q$insert into public.habit_logs (user_id, habit_id, date, status) values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '2026-01-06', 'done')$q$,
    $q$insert into public.rituals (user_id, name, weekday, time) values ('00000000-0000-0000-0000-00000000000a', 'X', 1, '09:00')$q$,
    $q$insert into public.ritual_logs (user_id, ritual_id, week_start) values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', '2026-01-12')$q$,
    $q$insert into public.events (user_id, title, date) values ('00000000-0000-0000-0000-00000000000a', 'X', '2026-01-07')$q$,
    $q$insert into public.sleep (user_id, night_of, bed_at, wake_at) values ('00000000-0000-0000-0000-00000000000a', '2026-01-06', '2026-01-06 22:00+00', '2026-01-07 06:00+00')$q$,
    $q$insert into public.water (user_id, liters) values ('00000000-0000-0000-0000-00000000000a', 0.25)$q$,
    $q$insert into public.daily (user_id, date) values ('00000000-0000-0000-0000-00000000000a', '2026-01-06')$q$,
    $q$insert into public.books (user_id, title) values ('00000000-0000-0000-0000-00000000000a', 'X')$q$,
    $q$insert into public.reviews (user_id, week_start) values ('00000000-0000-0000-0000-00000000000a', '2026-01-12')$q$
  ];
  names text[] := array['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','daily','books','reviews'];
  i int;
begin
  for i in 1 .. array_length(stmts, 1) loop
    begin
      execute stmts[i];
      raise exception 'FAIL: % B inserted a row owned by A', names[i];
    exception
      when insufficient_privilege then null; -- 42501 expected
    end;
  end loop;
end $$;

-- 4. Switch to A: exactly one row per table
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
do $$
declare t text; n bigint;
begin
  foreach t in array array['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','daily','books','reviews'] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 1 then raise exception 'FAIL: % A sees % rows, expected 1', t, n; end if;
  end loop;
end $$;

-- 5. anon is denied everywhere (SQLSTATE 42501)
set local role anon;
do $$
declare t text;
begin
  foreach t in array array['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','daily','books','reviews'] loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'FAIL: % anon can select', t;
    exception
      when insufficient_privilege then null; -- 42501 expected
    end;
  end loop;
end $$;

-- 6. Grants: anon has nothing on any v1 table; authenticated has exactly SELECT, INSERT, UPDATE, DELETE.
-- has_table_privilege works whatever role runs this, so reset first (section 5 left us as anon).
reset role;
do $$
declare t text; p text;
begin
  foreach t in array array['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','daily','books','reviews'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', format('public.%I', t), p) then
        raise exception 'FAIL: grant: anon has % on % (apply 003_tighten_grants.sql)', p, t;
      end if;
      if has_table_privilege('authenticated', format('public.%I', t), p) <> (p in ('SELECT','INSERT','UPDATE','DELETE')) then
        raise exception 'FAIL: grant: authenticated has the wrong % privilege on % (apply 003_tighten_grants.sql)', p, t;
      end if;
    end loop;
  end loop;
end $$;

rollback;
-- Reached only if every assertion above passed (a failure aborts the script).
select 'RLS OK' as result;
