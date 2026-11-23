import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { V1_TABLES } from '../../js/data/tables.js';

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

test('rls.sql is wrapped and ends with rollback', () => {
  assert.ok(/^\s*begin;/m.test(rls));
  assert.ok(rls.includes("select 'rls ok' as result;"));
  assert.ok(rls.trim().endsWith('rollback;'));
});
