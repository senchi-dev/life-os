import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWeekStart, weeklyReview, weekToDate } from '../../js/lib/review.js';

test('reviewWeekStart', () => {
  assert.equal(reviewWeekStart('2026-11-29'), '2026-11-23');
  assert.equal(reviewWeekStart('2026-11-25'), '2026-11-16');
});

const habit = { id: 'h1', name: 'Read', schedule_kind: 'daily', weekdays: null, target_n: null, active: true, sort: 0 };
const log = (date, status = 'done') => ({ habit_id: 'h1', date, status });
const settings = { water_target_l: 2.5, weekly_pages: 200 };
const W = '2026-11-16';

test('weeklyReview habits: hits, missed days, missed twice', () => {
  const logs = ['16', '17', '18', '19', '22'].map((d) => log(`2026-11-${d}`));
  const r = weeklyReview({ weekStart: W, habits: [habit], habitLogs: logs, sleep: [], water: [], daily: [], settings });
  assert.equal(r.weekEnd, '2026-11-22');
  const h = r.habits[0];
  assert.equal(h.id, 'h1'); assert.equal(h.name, 'Read');
  assert.equal(h.hits, 5); assert.equal(h.target, 7);
  assert.equal(h.missedDays, 2); assert.equal(h.missedTwice, 1);
  assert.equal(typeof h.consistency28, 'number');
});

test('skipped is not missed; separate runs counted', () => {
  const logs = [log('2026-11-17', 'skipped'), log('2026-11-19'), log('2026-11-21')];
  const r = weeklyReview({ weekStart: W, habits: [habit], habitLogs: logs, sleep: [], water: [], daily: [], settings });
  // missed: 16, 18, 20, 22 -> no two consecutive
  assert.equal(r.habits[0].missedDays, 4); assert.equal(r.habits[0].missedTwice, 0);
});

test('inactive habits excluded', () => {
  const r = weeklyReview({ weekStart: W, habits: [{ ...habit, active: false }], habitLogs: [], sleep: [], water: [], daily: [], settings });
  assert.equal(r.habits.length, 0);
});

test('water days on target', () => {
  const at = (d, h) => new Date(2026, 10, d, h, 0);
  const water = [
    { at: at(16, 9), liters: 1.5 }, { at: at(16, 15), liters: 1 },
    { at: at(17, 9), liters: 2.5 }, { at: at(18, 9), liters: 2.5 },
    { at: at(19, 9), liters: 2.4 },
    { at: at(25, 9), liters: 3 }, // outside week
  ];
  const r = weeklyReview({ weekStart: W, habits: [], habitLogs: [], sleep: [], water, daily: [], settings });
  assert.deepEqual(r.water, { daysOnTarget: 3, days: 7, target: 2.5 });
});

test('pages and mood', () => {
  const daily = [
    { date: '2026-11-16', pages: 20, mood: 3 }, { date: '2026-11-17', pages: 30, mood: 4 },
    { date: '2026-11-18', pages: 0, mood: null }, { date: '2026-11-19', pages: 50, mood: 4 },
    { date: '2026-11-23', pages: 99, mood: 1 },
  ];
  const r = weeklyReview({ weekStart: W, habits: [], habitLogs: [], sleep: [], water: [], daily, settings });
  assert.deepEqual(r.pages, { total: 100, target: 200 });
  assert.deepEqual(r.mood, { avg: 3.7, n: 3 });
  const e = weeklyReview({ weekStart: W, habits: [], habitLogs: [], sleep: [], water: [], daily: [], settings });
  assert.deepEqual(e.mood, { avg: null, n: 0 });
});

test('sleep uses rows with night_of in week', () => {
  const row = (night, bh, wd) => ({ night_of: night, bed_at: new Date(2026, 10, +night.slice(8), bh, 0), wake_at: new Date(2026, 10, wd, 7, 0) });
  const sleep = [row('2026-11-16', 23, 17), row('2026-11-17', 23, 18), row('2026-11-15', 23, 16)];
  const r = weeklyReview({ weekStart: W, habits: [], habitLogs: [], sleep, water: [], daily: [], settings });
  assert.equal(r.sleep.nights, 2); assert.equal(r.sleep.avgMinutes, 480); assert.equal(r.sleep.avgBed, '23:00');
});

test('weekToDate counts today in target', () => {
  const logs = [log('2026-11-23'), log('2026-11-24')];
  const daily = [{ date: '2026-11-23', pages: 10 }, { date: '2026-11-25', pages: 5 }, { date: '2026-11-22', pages: 70 }];
  const r = weekToDate({ todayKey: '2026-11-25', habits: [habit], habitLogs: logs, daily, settings });
  assert.equal(r.habitsPct, 67); assert.equal(r.pages, 15); assert.equal(r.pagesTarget, 200);
  const none = weekToDate({ todayKey: '2026-11-25', habits: [], habitLogs: [], daily: [], settings });
  assert.equal(none.habitsPct, null);
});

test('habit created mid-week: days before created_at are not misses and not in target', () => {
  const created = { ...habit, created_at: new Date(2026, 10, 18, 9, 0).toISOString() }; // Wed 18th local
  const logs = [log('2026-11-18'), log('2026-11-19')];
  const r = weeklyReview({ weekStart: W, habits: [created], habitLogs: logs, sleep: [], water: [], daily: [], settings });
  const h = r.habits[0];
  assert.equal(h.target, 5); assert.equal(h.hits, 2);
  assert.equal(h.missedDays, 3); assert.equal(h.missedTwice, 1); // 20,21,22 only
});

test('habit created after the week: no misses, target 0', () => {
  const created = { ...habit, created_at: new Date(2026, 10, 25, 9, 0).toISOString() };
  const r = weeklyReview({ weekStart: W, habits: [created], habitLogs: [], sleep: [], water: [], daily: [], settings });
  assert.equal(r.habits[0].missedDays, 0); assert.equal(r.habits[0].missedTwice, 0); assert.equal(r.habits[0].target, 0);
});

test('habit without created_at behaves as before', () => {
  const r = weeklyReview({ weekStart: W, habits: [habit], habitLogs: [], sleep: [], water: [], daily: [], settings });
  assert.equal(r.habits[0].missedDays, 7); assert.equal(r.habits[0].target, 7);
});
