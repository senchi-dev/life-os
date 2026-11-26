import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALVIEW_KEY, CAL_VIEWS, readCalView, writeCalView, weekDays, monthGrid, rangeFor, step,
} from '../../js/lib/cal-range.js';
import { addDays, isoWeekday } from '../../js/lib/dates.js';

test('readCalView/writeCalView', () => {
  assert.equal(CALVIEW_KEY, 'lifeos-calview');
  assert.deepEqual(CAL_VIEWS, ['agenda', 'day', 'week', 'month']);
  for (const v of CAL_VIEWS) {
    const store = {};
    const s = { setItem: (k, x) => { store[k] = x; }, getItem: (k) => store[k] ?? null };
    assert.equal(writeCalView(s, v), true);
    assert.equal(store[CALVIEW_KEY], v);
    assert.equal(readCalView(s), v);
  }
  assert.equal(readCalView({ getItem: () => 'year' }), 'agenda');
  assert.equal(readCalView({ getItem: () => null }), 'agenda');
  assert.equal(readCalView({ getItem: () => { throw new Error('x'); } }), 'agenda');
  assert.equal(readCalView(undefined), 'agenda');
  const store = {};
  assert.equal(writeCalView({ setItem: (k, x) => { store[k] = x; } }, 'year'), false);
  assert.equal(CALVIEW_KEY in store, false);
  assert.equal(writeCalView({ setItem: () => { throw new Error('x'); } }, 'week'), false);
});

const flat = (g) => g.weeks.flat();

test('monthGrid: March 2026 starts on Sunday, 31 days', () => {
  const g = monthGrid('2026-03-15');
  assert.equal(g.month, '2026-03');
  assert.equal(g.weeks.length, 6);
  assert.deepEqual(g.weeks[0][0], { date: '2026-02-23', inMonth: false });
  assert.deepEqual(g.weeks[0][6], { date: '2026-03-01', inMonth: true });
  assert.deepEqual(g.weeks[5][6], { date: '2026-04-05', inMonth: false });
  assert.equal(flat(g).filter((c) => c.inMonth).length, 31);
});

test('monthGrid: February 2026 (Sunday, 28 days)', () => {
  const g = monthGrid('2026-02-01');
  assert.equal(g.weeks.length, 5);
  assert.equal(g.weeks[0][0].date, '2026-01-26');
  assert.equal(g.weeks[4][6].date, '2026-03-01');
});

test('monthGrid: February 2027 (Monday, 28 days)', () => {
  const g = monthGrid('2027-02-10');
  assert.equal(g.weeks.length, 4);
  assert.ok(flat(g).every((c) => c.inMonth));
  assert.equal(g.weeks[0][0].date, '2027-02-01');
  assert.equal(g.weeks[3][6].date, '2027-02-28');
});

test('monthGrid: November 2026 (Sunday, 30 days)', () => {
  const g = monthGrid('2026-11-26');
  assert.equal(g.weeks.length, 6);
  for (const row of g.weeks) {
    assert.equal(row.length, 7);
    assert.equal(isoWeekday(row[0].date), 1);
  }
  const cells = flat(g);
  for (let i = 1; i < cells.length; i++) assert.equal(cells[i].date, addDays(cells[i - 1].date, 1));
});

test('weekDays across DST', () => {
  for (const sunday of ['2026-10-25', '2026-03-29', '2026-09-27', '2026-04-05']) {
    const days = weekDays(sunday);
    assert.equal(days.length, 7);
    assert.equal(new Set(days).size, 7);
    assert.equal(isoWeekday(days[0]), 1);
    for (let i = 1; i < 7; i++) assert.equal(days[i], addDays(days[i - 1], 1));
    assert.equal(days[6], sunday);
  }
});

test('step', () => {
  assert.equal(step('month', '2026-01-31', 1), '2026-02-28');
  assert.equal(step('month', '2028-01-31', 1), '2028-02-29');
  assert.equal(step('month', '2026-03-31', -1), '2026-02-28');
  assert.equal(step('month', '2026-12-15', 1), '2027-01-15');
  assert.equal(step('month', '2026-01-15', -1), '2025-12-15');
  assert.equal(step('day', '2026-10-24', 1), '2026-10-25');
  assert.equal(step('day', '2026-10-25', 1), '2026-10-26');
  assert.equal(step('day', '2026-10-26', -1), '2026-10-25');
  assert.equal(step('week', '2026-10-21', 1), '2026-10-28');
  assert.equal(step('week', '2026-10-28', -1), '2026-10-21');
  assert.equal(step('agenda', '2026-11-26', 1), '2026-11-26');
});

test('rangeFor', () => {
  const a = '2026-11-26';
  assert.deepEqual(rangeFor('agenda', a, a), { from: '2026-11-26', to: '2026-12-02' });
  assert.deepEqual(rangeFor('agenda', '2027-01-10', a), { from: '2026-11-26', to: '2026-12-02' });
  assert.deepEqual(rangeFor('day', a, a), { from: a, to: a });
  assert.deepEqual(rangeFor('week', a, a), { from: '2026-11-23', to: '2026-11-29' });
  assert.deepEqual(rangeFor('month', a, a), { from: '2026-10-26', to: '2026-12-06' });
});
