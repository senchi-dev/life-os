import test from 'node:test';
import assert from 'node:assert/strict';
import { dayScore } from '../../js/lib/score.js';

const S = '2026-11-28'; // Saturday
const at = (key, h, m = 0) => { const [y, mo, d] = key.split('-').map(Number); return new Date(y, mo - 1, d, h, m); };
const habit = (id, extra = {}) => ({ id, schedule_kind: 'daily', weekdays: null, target_n: null, active: true, created_at: '2026-01-01T00:00:00Z', ...extra });
const log = (habit_id, status = 'done', date = S) => ({ habit_id, date, status });
const water = [{ at: at(S, 8).toISOString(), liters: 1 }, { at: at(S, 10).toISOString(), liters: 0.5 }];
const sleep = [{ night_of: '2026-11-27', bed_at: at('2026-11-27', 23, 15).toISOString(), wake_at: at(S, 7).toISOString() }];
const settings = { water_target_l: 2.5 };
const now = at(S, 18);
const base = { habits: [], habitLogs: [], water, sleep, settings, dateKey: S, now };
const habits = [
  habit('A'), habit('B'), habit('C', { schedule_kind: 'weekdays', weekdays: [1, 2, 3, 4, 5] }),
  habit('G', { schedule_kind: 'n_per_week', target_n: 3 }), habit('D'),
];

test('H counts due habits, excludes skipped and not due', () => {
  const r = dayScore({ ...base, habits, habitLogs: [log('A'), log('D', 'skipped')] });
  assert.deepEqual(r.parts.H, { done: 1, counted: 2 });
  assert.equal(r.score, 67);
  assert.equal(r.good, false);
});

test('n_per_week counts when done that day', () => {
  const r = dayScore({ ...base, habits, habitLogs: [log('A'), log('D', 'skipped'), log('G')] });
  assert.deepEqual(r.parts.H, { done: 2, counted: 3 });
  assert.equal(r.score, 74);
});

test('absent H and S before noon today', () => {
  const r = dayScore({ ...base, habits: [habits[2]], sleep: [], now: at(S, 9) });
  assert.equal(r.parts.H, null);
  assert.equal(r.parts.S, null);
  assert.equal(r.score, 60);
});

test('missing S counts as 0 from noon', () => {
  const r = dayScore({ ...base, habits: [habits[2]], sleep: [], now: at(S, 12) });
  assert.equal(r.score, 30);
});

test('perfect day is good', () => {
  const r = dayScore({ ...base, habits: [habits[0]], habitLogs: [log('A')], water: [{ at: at(S, 9).toISOString(), liters: 4 }],
    sleep: [{ night_of: '2026-11-27', bed_at: at('2026-11-27', 21).toISOString(), wake_at: at(S, 7).toISOString() }] });
  assert.equal(r.score, 100);
  assert.equal(r.good, true);
});

test('habit created tomorrow is not counted', () => {
  const r = dayScore({ ...base, habits: [habit('N', { created_at: at('2026-11-29', 10).toISOString() })] });
  assert.equal(r.parts.H, null);
});

test('past day without sleep gives S = 0 regardless of hour', () => {
  const r = dayScore({ ...base, sleep: [], dateKey: '2026-11-27', now: at(S, 9), water: [] });
  assert.equal(r.parts.S.minutes, 0);
  assert.equal(r.score, 0);
});

test('default water target 2.5 when settings missing', () => {
  const r = dayScore({ ...base, settings: null });
  assert.equal(r.parts.W.target, 2.5);
  assert.equal(r.parts.W.liters, 1.5);
});
