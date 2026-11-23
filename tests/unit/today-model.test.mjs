import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSeed } from '../../js/data/demo-seed.js';
import { defaultTimes } from '../../js/lib/health.js';
import { buildTodayModel } from '../../js/ui/today-model.js';

const TODAY = '2026-11-23';
const snapOf = (seed) => ({
  settings: seed.settings[0] ?? null, habits: seed.habits, habitLogs: seed.habit_logs, rituals: seed.rituals,
  ritualLogs: seed.ritual_logs, events: seed.events, sleep: seed.sleep, water: seed.water,
  daily: seed.daily, books: seed.books, reviews: seed.reviews,
});
const fresh = () => snapOf(demoSeed(TODAY));

test('header, now/next, water, habits from the demo seed', () => {
  const m = buildTodayModel(fresh(), TODAY, '10:00');
  assert.equal(m.dayLabel, 'Mon 23 Nov');
  assert.deepEqual(m.nowNext.map((e) => e.title), ['Rates desk', 'Gym']);
  assert.equal(m.habits.length, 4);
  assert.equal(m.habits.find((h) => h.name === 'Read').flag, 'red');
  assert.equal(m.water.total, 1.5);
  assert.equal(m.water.target, 2.5);
  assert.equal(m.water.last.liters, 1.5);
  assert.equal(m.pages.book.title, 'Investment Banking');
  assert.equal(m.mood, null);
});

test('no sleep row for last night: defaults, not logged', () => {
  const s = fresh();
  s.sleep = s.sleep.filter((r) => r.night_of !== '2026-11-22');
  const m = buildTodayModel(s, TODAY, '10:00');
  const d = defaultTimes(s.sleep);
  assert.equal(m.sleep.logged, false);
  assert.equal(m.sleep.bed, d.bed);
  assert.equal(m.sleep.wake, d.wake);
  assert.equal(m.sleep.minutes, null);
  const logged = buildTodayModel(fresh(), TODAY, '10:00');
  assert.equal(logged.sleep.logged, true);
  assert.ok(logged.sleep.minutes > 300);
});

test('overdue ritual appears', () => {
  const m = buildTodayModel(fresh(), TODAY, '10:00');
  const c = m.rituals.find((r) => r.ritual.name === 'Cleaning reset');
  assert.ok(c);
  assert.equal(c.overdue, true);
});

test('habits are capped at 6, sorted, active only', () => {
  const s = fresh();
  for (let i = 0; i < 3; i++) s.habits.push({ id: `x${i}`, name: `Extra ${i}`, schedule_kind: 'daily', active: true, sort: 10 + i, created_at: '2026-01-01T09:00:00Z' });
  s.habits.push({ id: 'off', name: 'Off', schedule_kind: 'daily', active: false, sort: -1, created_at: '2026-01-01T09:00:00Z' });
  const m = buildTodayModel(s, TODAY, '10:00');
  assert.equal(m.habits.length, 6);
  assert.ok(!m.habits.some((h) => h.id === 'off'));
  assert.deepEqual(m.habits.map((h) => h.id).slice(4), ['x0', 'x1']);
});

test('a habit created yesterday with no logs is not flagged', () => {
  const s = fresh();
  s.habits.push({ id: 'new', name: 'New', schedule_kind: 'daily', active: true, sort: 9, created_at: new Date(2026, 10, 22, 12).toISOString() });
  const h = buildTodayModel(s, TODAY, '10:00').habits.find((x) => x.id === 'new');
  assert.equal(h.flag, 'none');
});

test('a habit created 5 days ago with no logs is capped by its age', () => {
  const s = fresh();
  s.habits.push({ id: 'n5', name: 'N5', schedule_kind: 'daily', active: true, sort: 9, created_at: new Date(2026, 10, 18, 12).toISOString() });
  const h = buildTodayModel(s, TODAY, '10:00').habits.find((x) => x.id === 'n5');
  assert.equal(h.missRun, 4);
});

test('first run: empty snapshot uses defaults and does not throw', () => {
  const m = buildTodayModel({ settings: null, habits: [], habitLogs: [], rituals: [], ritualLogs: [], events: [], sleep: [], water: [], daily: [], books: [], reviews: [] }, TODAY, '10:00');
  assert.equal(m.water.target, 2.5);
  assert.equal(m.week.pagesTarget, 200);
  assert.deepEqual(m.habits, []);
  assert.equal(m.pages.book, null);
  assert.equal(m.water.last, null);
});

import { isNewDay, localDateKey } from '../../js/lib/dates.js';

test('isNewDay compares the local date of now with todayKey', () => {
  assert.equal(isNewDay(TODAY, new Date(2026, 10, 23, 23, 59)), false);
  assert.equal(isNewDay(TODAY, new Date(2026, 10, 24, 0, 30)), true);
  assert.equal(isNewDay('2026-11-24', new Date(2026, 10, 24, 0, 30)), false);
});

test('water at 00:30 on the new day counts for the new day, 23:30 the day before does not', () => {
  const s = fresh();
  const NEW = '2026-11-24';
  s.water = [
    { id: 'a', at: new Date(2026, 10, 23, 23, 30).toISOString(), liters: 1 },
    { id: 'b', at: new Date(2026, 10, 24, 0, 30).toISOString(), liters: 0.5 },
  ];
  assert.equal(localDateKey(new Date(s.water[1].at)), NEW);
  const m = buildTodayModel(s, NEW, '00:31');
  assert.equal(m.water.total, 0.5);
  assert.equal(m.water.last.id, 'b');
  assert.equal(buildTodayModel(s, TODAY, '23:45').water.total, 1);
});

test('current book: marker wins, then latest started_on, then created_at, then id', () => {
  const mk = (id, started_on, created_at, finished_on = null) => ({ id, title: id, started_on, created_at, finished_on });
  const base = () => ({ ...fresh(), books: [mk('a', '2026-01-01', '2026-01-01T00:00:00Z'), mk('b', '2026-02-01', '2026-02-01T00:00:00Z')] });
  const titleOf = (s) => buildTodayModel(s, TODAY, '10:00').pages.book?.title;
  // fallback: latest started_on
  assert.equal(titleOf(base()), 'b');
  // marker wins
  const s1 = base(); s1.settings = { ...s1.settings, current_book_id: 'a' };
  assert.equal(titleOf(s1), 'a');
  // marker pointing at a finished or missing book is ignored
  const s2 = base(); s2.books[0].finished_on = '2026-03-01'; s2.settings = { ...s2.settings, current_book_id: 'a' };
  assert.equal(titleOf(s2), 'b');
  const s3 = base(); s3.settings = { ...s3.settings, current_book_id: 'zzz' };
  assert.equal(titleOf(s3), 'b');
  // tie on started_on: created_at desc, then id
  const s4 = { ...base(), books: [mk('a', '2026-02-01', '2026-02-01T00:00:00Z'), mk('b', '2026-02-01', '2026-02-02T00:00:00Z')] };
  assert.equal(titleOf(s4), 'b');
  const s5 = { ...base(), books: [mk('a', '2026-02-01', '2026-02-01T00:00:00Z'), mk('b', '2026-02-01', '2026-02-01T00:00:00Z')] };
  assert.equal(titleOf(s5), 'a');
});
