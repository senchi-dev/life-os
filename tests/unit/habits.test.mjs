import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../../js/lib/dates.js';
import {
  isDue, consistency28, streak, missRun, habitFlag, weekHits,
  nextStatus, MAX_ACTIVE_HABITS, canActivate,
} from '../../js/lib/habits.js';

const TODAY = '2026-11-23';
const daily = { id: 'h', name: 'x', schedule_kind: 'daily', weekdays: null, target_n: null, active: true, sort: 0 };
const wk135 = { ...daily, schedule_kind: 'weekdays', weekdays: [1, 3, 5] };
const nper3 = { ...daily, schedule_kind: 'n_per_week', target_n: 3 };
const logs = (habitId, map) =>
  Object.entries(map).map(([date, status]) => ({ habit_id: habitId, date, status }));
const range = (from, to, status = 'done') => {
  const m = {};
  for (let d = from; d <= to; d = addDays(d, 1)) m[d] = status;
  return m;
};

test('isDue', () => {
  assert.equal(isDue(wk135, '2026-11-23'), true);
  assert.equal(isDue(wk135, '2026-11-24'), false);
  assert.equal(isDue(daily, '2026-11-24'), true);
  assert.equal(isDue(nper3, '2026-11-24'), true);
});

test('consistency28 daily', () => {
  const done = range('2026-11-02', '2026-11-22');
  assert.equal(consistency28(daily, logs('h', done), TODAY), 21 / 27);
  const skipped = logs('h', { ...done, '2026-10-28': 'skipped', '2026-10-30': 'skipped' });
  assert.equal(consistency28(daily, skipped, TODAY), 21 / 25);
  const todayDone = logs('h', { ...done, [TODAY]: 'done' });
  assert.equal(consistency28(daily, todayDone, TODAY), 22 / 28);
});

test('consistency28 ignores other habits and returns null when no denominator', () => {
  assert.equal(consistency28(daily, logs('other', range('2026-11-02', '2026-11-22')), TODAY), 0);
  const allSkipped = logs('h', range('2026-10-27', '2026-11-22', 'skipped'));
  assert.equal(consistency28(daily, allSkipped, TODAY), null);
});

test('consistency28 n_per_week', () => {
  const l = [];
  const put = (start, n) => { for (let i = 0; i < n; i++) l.push(...logs('h', { [addDays(start, i)]: 'done' })); };
  put('2026-10-26', 3); put('2026-11-02', 4); put('2026-11-09', 1); put('2026-11-16', 2);
  assert.equal(consistency28(nper3, l, TODAY), (3 + 3 + 1 + 2) / 12);
});

test('streak', () => {
  assert.equal(streak(daily, logs('h', { '2026-11-21': 'done', '2026-11-22': 'done' }), TODAY), 2);
  assert.equal(streak(daily, logs('h', { '2026-11-21': 'done', '2026-11-22': 'done', [TODAY]: 'done' }), TODAY), 3);
  assert.equal(streak(daily, logs('h', { '2026-11-20': 'done', '2026-11-21': 'skipped', '2026-11-22': 'done' }), TODAY), 2);
  assert.equal(streak(daily, [], TODAY), 0);
});

test('streak weekdays skips non-due days and n_per_week counts weeks', () => {
  // Fri 20 and Wed 18 done, Sat/Sun/Mon(today, unlogged)/Tue 19 not due or transparent
  assert.equal(streak(wk135, logs('h', { '2026-11-20': 'done', '2026-11-18': 'done' }), TODAY), 2);
  const l = [];
  for (const s of ['2026-11-16', '2026-11-09']) for (let i = 0; i < 3; i++) l.push(...logs('h', { [addDays(s, i)]: 'done' }));
  l.push(...logs('h', { '2026-11-02': 'done' }));
  assert.equal(streak(nper3, l, TODAY), 2);
});

test('missRun and habitFlag', () => {
  assert.equal(missRun(daily, logs('h', { '2026-11-20': 'done' }), TODAY), 2);
  assert.equal(habitFlag(2), 'red');
  assert.equal(habitFlag(1), 'warn');
  assert.equal(habitFlag(0), 'none');
  assert.equal(missRun(wk135, logs('h', { '2026-11-18': 'done' }), TODAY), 1);
  assert.equal(missRun(nper3, [], TODAY), 0);
  assert.equal(missRun(daily, logs('h', { '2026-11-21': 'skipped', '2026-11-20': 'done' }), TODAY), 1);
});

test('weekHits', () => {
  const l = logs('h', { '2026-11-23': 'done', '2026-11-24': 'skipped', '2026-11-25': 'done' });
  assert.deepEqual(weekHits(daily, l, '2026-11-23', '2026-11-25'), { hits: 2, target: 2 });
  assert.deepEqual(weekHits(daily, l, '2026-11-23'), { hits: 2, target: 6 });
  assert.deepEqual(weekHits(nper3, l, '2026-11-23', '2026-11-25'), { hits: 2, target: 3 });
});

test('nextStatus', () => {
  assert.equal(nextStatus(null, 'tap'), 'done');
  assert.equal(nextStatus('done', 'tap'), null);
  assert.equal(nextStatus('skipped', 'tap'), 'done');
  assert.equal(nextStatus(null, 'hold'), 'skipped');
  assert.equal(nextStatus('skipped', 'hold'), null);
  assert.equal(nextStatus('done', 'hold'), 'skipped');
});

test('canActivate', () => {
  const mk = (n, active) => Array.from({ length: n }, (_, i) => ({ ...daily, id: `${active}${i}`, active }));
  assert.equal(MAX_ACTIVE_HABITS, 6);
  assert.equal(canActivate(mk(6, true)), false);
  assert.equal(canActivate([...mk(5, true), ...mk(3, false)]), true);
});

// ---- B4: new-habit-aware consistency28 ----
const at = (iso) => ({ created_at: iso });

test('consistency28: a 3-day-old daily habit counts only the days that existed (3/3 done = 100%)', () => {
  const h = { ...daily, ...at('2026-11-20T10:00:00') }; // local date 2026-11-20
  const l = logs('h', { '2026-11-20': 'done', '2026-11-21': 'done', '2026-11-22': 'done' });
  assert.equal(consistency28(h, l, TODAY), 1);
});

test('consistency28: a habit created today has no due days yet => null', () => {
  const h = { ...daily, ...at('2026-11-23T08:00:00') };
  assert.equal(consistency28(h, [], TODAY), null);
});

test('consistency28: born date is the LOCAL date (TZ-discriminating, 00:30 local)', () => {
  // 00:30 local on 2026-11-20 is 2026-11-19 in UTC for Paris (UTC+1) but the same local day in Auckland.
  const local = new Date(2026, 10, 20, 0, 30, 0);
  const h = { ...daily, created_at: local.toISOString() };
  const l = logs('h', { '2026-11-20': 'done', '2026-11-21': 'done', '2026-11-22': 'done' });
  assert.equal(consistency28(h, l, TODAY), 1); // 11-20 counts, 11-19 does not
  const withMiss = logs('h', { '2026-11-21': 'done', '2026-11-22': 'done' });
  assert.equal(consistency28(h, withMiss, TODAY), 2 / 3); // 11-20 is a counted miss
});

test('consistency28: invalid or missing created_at behaves like existed forever, never throws', () => {
  const done = range('2026-11-02', '2026-11-22');
  for (const created_at of ['not-a-date', '', null, undefined]) {
    assert.equal(consistency28({ ...daily, created_at }, logs('h', done), TODAY), 21 / 27, String(created_at));
  }
});

test('consistency28: weekdays habit respects the creation date', () => {
  const h = { ...wk135, ...at('2026-11-18T09:00:00') }; // Wed; due days since: Wed18 Fri20 Mon23(today, unlogged skipped)
  const l = logs('h', { '2026-11-18': 'done', '2026-11-20': 'done' });
  assert.equal(consistency28(h, l, TODAY), 1);
});

test('consistency28 n_per_week: weeks starting before creation are skipped; null if none left', () => {
  const l = logs('h', { ...range('2026-11-02', '2026-11-08'), ...range('2026-11-09', '2026-11-15') });
  // created Mon 2026-11-09 => weeks starting 11-09 counts, 11-02 skipped; weeks 11-16 (complete before today 11-23) counts
  const h = { ...nper3, ...at('2026-11-09T08:00:00') };
  assert.equal(consistency28(h, l, TODAY), (3 + 0) / 6);
  assert.equal(consistency28({ ...nper3, ...at('2026-11-22T08:00:00') }, l, TODAY), null);
  assert.equal(consistency28({ ...nper3, created_at: 'garbage' }, l, TODAY), (3 + 3 + 0 + 0) / 12);
});

test('consistency28 n_per_week: the reviewed week counts once it is complete (Sunday)', () => {
  const l = logs('h', range('2026-11-16', '2026-11-22'));
  const h = { ...nper3, ...at('2026-11-16T08:00:00') };
  assert.equal(consistency28(h, l, '2026-11-22'), 1);
});
