import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { V1_TABLES, GYM_TABLES, ALL_TABLES } from '../../js/data/tables.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').toLowerCase();
const mig = read('../../supabase/migrations/001_v1_schema.sql');
const rls = read('../../supabase/tests/rls.sql');

test('V1_TABLES lists the 11 v1 tables', () => {
  assert.equal(V1_TABLES.length, 11);
});

for (const t of V1_TABLES) {
  test(`migration secures ${t}`, () => {
    assert.ok(mig.includes(`create table public.${t} `) || mig.includes(`create table public.${t}(`), 'create table');
    assert.ok(mig.includes(`alter table public.${t} enable row level security`), 'enable rls');
    assert.ok(mig.includes(`alter table public.${t} force row level security`), 'force rls');
    const pol = new RegExp(`create policy [a-z_]+ on public\\.${t}\\b[^;]*auth\\.uid\\(\\)`);
    assert.match(mig, pol, 'policy with auth.uid()');
    assert.ok(mig.includes(`revoke all on public.${t} from anon`), 'revoke anon');
    assert.match(mig, new RegExp(`grant select, insert, update, delete on public\\.${t} to authenticated`));
  });
  test(`rls.sql covers ${t}`, () => {
    assert.match(rls, new RegExp(`\\b${t}\\b`));
  });
}

test('migration never uses aal2, grants to anon, or security definer', () => {
  assert.ok(!mig.includes('aal2'));
  assert.ok(!rls.includes('aal2'));
  assert.ok(!/grant[^;]*\bto\b[^;]*\banon\b/.test(mig));
  assert.ok(!mig.includes('security definer'));
});

test('every auth.uid() is a column default or wrapped in (select ...)', () => {
  const bad = mig.match(/(?<!default )(?<!\(select )auth\.uid\(\)/g) || [];
  assert.equal(bad.length, 0);
});

test('books is created before daily', () => {
  assert.ok(mig.indexOf('create table public.books') < mig.indexOf('create table public.daily'));
});

test('rls.sql is wrapped in begin/rollback and ends with the RLS OK select', () => {
  assert.ok(/^\s*begin;/m.test(rls));
  assert.ok(/^rollback;/m.test(rls));
  assert.ok(rls.trim().endsWith("select 'rls ok' as result;"));
  assert.ok(rls.lastIndexOf('rollback;') < rls.lastIndexOf("select 'rls ok' as result;"));
});

test('V1_TABLES lists every parent before its child', () => {
  const i = (t) => V1_TABLES.indexOf(t);
  assert.ok(i('habits') < i('habit_logs'));
  assert.ok(i('rituals') < i('ritual_logs'));
  assert.ok(i('books') < i('daily'));
});

test('002_current_book.sql adds the nullable marker and stays safe', () => {
  const m2 = read('../../supabase/migrations/002_current_book.sql');
  assert.ok(m2.includes('alter table public.settings add column if not exists current_book_id uuid references public.books(id) on delete set null;'));
  assert.ok(!m2.includes('aal2'));
  assert.ok(!/grant[^;]*\bto\b[^;]*\banon\b/.test(m2));
  assert.ok(!m2.includes('security definer'));
  assert.ok(!/not null/.test(m2));
});

// ---- R6: 003 tightens grants ----
const m3 = read('../../supabase/migrations/003_tighten_grants.sql');
for (const t of V1_TABLES) {
  test(`003 revokes all from authenticated on ${t} then regrants the four verbs`, () => {
    const rev = m3.indexOf(`revoke all on public.${t} from authenticated;`);
    const gr = m3.indexOf(`grant select, insert, update, delete on public.${t} to authenticated;`);
    assert.ok(rev >= 0, 'revoke all');
    assert.ok(gr > rev, 'regrant after revoke');
  });
}

test('003 is safe: no anon grant, aal2 or security definer', () => {
  assert.ok(!/grant[^;]*\bto\b[^;]*\banon\b/.test(m3));
  assert.ok(!m3.includes('aal2'));
  assert.ok(!m3.includes('security definer'));
});

test('rls.sql asserts table grants and says it needs 001, 002 and 003', () => {
  assert.ok(rls.includes('has_table_privilege') || rls.includes('role_table_grants'));
  assert.match(rls, /after 001[^\n]*002[^\n]*003/);
  assert.match(rls, /fail: [^']*grant/);
});

// ---- Phase 2a: 004 gym schema ----
const sha = (f) => createHash('sha256').update(readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url))).digest('hex');
test('migrations 001-003 are frozen (already applied live)', () => {
  assert.equal(sha('001_v1_schema.sql'), 'eaf35a2cd5672c2b76faf1115a923f70e1de79ecf83667c9ee885a906039c1b8');
  assert.equal(sha('002_current_book.sql'), 'a2d2cd40b14c95d6dc842f9f9affe4c808165a2bfae6c18e191f2f40a8492902');
  assert.equal(sha('003_tighten_grants.sql'), 'dc9ae27fead8ebff21f0a845b6122b5d504935754f097ed39e7308fc20a8e9ac');
});

const m4 = read('../../supabase/migrations/004_gym.sql');
for (const t of GYM_TABLES) {
  test(`004 secures ${t}`, () => {
    assert.ok(m4.includes(`create table if not exists public.${t}`), 'create table if not exists');
    assert.ok(m4.includes(`alter table public.${t} enable row level security;`), 'enable rls');
    assert.ok(m4.includes(`alter table public.${t} force row level security;`), 'force rls');
    const drop = m4.indexOf(`drop policy if exists owner_all on public.${t};`);
    const polFlat = m4.replace(/\s+/g, ' ').indexOf(`create policy owner_all on public.${t} for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));`);
    assert.ok(drop >= 0, 'drop policy if exists');
    assert.ok(polFlat >= 0, 'create policy owner_all');
    assert.ok(drop < m4.indexOf(`create policy owner_all on public.${t} `), 'drop before create');
    assert.ok(m4.includes(`revoke all on public.${t} from anon, public;`), 'revoke anon, public');
    const rev = m4.indexOf(`revoke all on public.${t} from authenticated;`);
    const gr = m4.indexOf(`grant select, insert, update, delete on public.${t} to authenticated;`);
    assert.ok(rev >= 0 && gr > rev, 'revoke authenticated then regrant');
    const dt = m4.indexOf(`drop trigger if exists ${t}_set_updated_at on public.${t};`);
    const ct = m4.indexOf(`create trigger ${t}_set_updated_at before update on public.${t}`);
    assert.ok(dt >= 0 && ct > dt, 'drop trigger then create trigger');
  });
  test(`rls.sql covers ${t}`, () => {
    assert.match(rls, new RegExp(`\\b${t}\\b`));
  });
}

test('004 is idempotent and safe', () => {
  for (const m of m4.match(/create table [^\n]*/g) ?? []) assert.ok(m.includes('if not exists'), m);
  for (const m of m4.match(/create (unique )?index [^\n]*/g) ?? []) assert.ok(m.includes('if not exists'), m);
  for (const m of m4.match(/add column [^\n]*/g) ?? []) assert.ok(m.includes('if not exists'), m);
  assert.ok(!m4.includes('drop table'));
  assert.ok(!m4.includes('aal2'));
  assert.ok(!m4.includes('security definer'));
  assert.ok(!/grant[^;]*\bto\b[^;]*\banon\b/.test(m4));
  assert.equal((m4.match(/create table /g) ?? []).length, 7);
});

test('004 exact fragments', () => {
  const flat = m4.replace(/\s+/g, ' ');
  for (const f of [
    'create unique index if not exists workouts_one_active on public.workouts (user_id) where ended_at is null;',
    'create unique index if not exists workouts_source_ref on public.workouts (user_id, source_ref) where source_ref is not null;',
    "check (type in ('normal','warmup','dropset','failure'))",
    'unique (user_id, weekday)',
    'check (not imported or (source_ref is not null and ended_at is not null))',
    'add column if not exists gym_habit_id uuid references public.habits(id) on delete set null',
    'add column if not exists gym_seeded_at timestamptz',
    'numeric(6,2)',
    'weekday smallint not null check (weekday between 1 and 7)',
    'routine_id uuid references public.routines(id) on delete set null',
  ]) assert.ok(flat.includes(f), f);
  assert.equal(flat.split('unique (user_id, name)').length - 1, 2);
  assert.equal(flat.split('references public.exercises(id) on delete restrict').length - 1, 2);
  assert.match(flat, /create index if not exists \w+ on public\.sets \(user_id\)/);
  assert.match(flat, /create index if not exists \w+ on public\.workout_exercises \(user_id, exercise_id, created_at desc\)/);
});

test('GYM_TABLES lists every parent before its child; ALL_TABLES has 18', () => {
  const i = (t) => GYM_TABLES.indexOf(t);
  assert.ok(i('exercises') < i('routine_items') && i('routines') < i('routine_items'));
  assert.ok(i('routines') < i('schedule_slots') && i('routines') < i('workouts'));
  assert.ok(i('workouts') < i('workout_exercises') && i('workout_exercises') < i('sets'));
  assert.ok(i('exercises') < i('workout_exercises'));
  assert.equal(ALL_TABLES.length, 18);
  assert.equal(new Set(ALL_TABLES).size, 18);
});

test('rls.sql header names 004 and every table array has 18 names', () => {
  assert.match(rls, /after 001[^\n]*004/);
  const arrays = rls.match(/array\['settings'[^\]]*\]/g) ?? [];
  assert.ok(arrays.length >= 4, 'table arrays present');
  for (const a of arrays) assert.equal((a.match(/'[a-z_]+'/g) ?? []).length, 18, a);
});

test('.gitignore and .gitattributes keep personal data and docs out', () => {
  const gi = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  for (const p of ['*.strive.json', '*.db', '*.sqlite']) assert.ok(gi.split('\n').includes(p), p);
  const ga = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8');
  assert.ok(ga.includes('docs/ export-ignore'));
  assert.ok(ga.includes('.superpowers/ export-ignore'));
});
