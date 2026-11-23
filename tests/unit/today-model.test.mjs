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
