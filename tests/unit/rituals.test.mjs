import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrence, ritualsForToday, toggleItem, DEFAULT_RITUALS } from '../../js/lib/rituals.js';

const R = DEFAULT_RITUALS.map((r, i) => ({ id: 'r' + i, ...r }));
const cleaning = R.find((r) => r.name === 'Cleaning reset');

test('occurrence is the most recent matching weekday <= today', () => {
  assert.equal(occurrence(cleaning, '2026-11-23'), '2026-11-21');
  assert.equal(occurrence(cleaning, '2026-11-21'), '2026-11-21');
  assert.equal(occurrence(cleaning, '2026-11-20'), '2026-11-14');
});

test('undone Cleaning reset is overdue on Monday', () => {
  const out = ritualsForToday([cleaning], [], '2026-11-23');
  assert.equal(out.length, 1);
  assert.equal(out[0].occurrence, '2026-11-21');
  assert.equal(out[0].weekStart, '2026-11-16');
  assert.equal(out[0].overdue, true);
  assert.equal(out[0].done, false);
  assert.equal(out[0].state.length, 8);
});

test('done Cleaning reset is not returned the next day', () => {
  const log = { ritual_id: cleaning.id, week_start: '2026-11-16', done_at: 'x', checklist_state: Array(8).fill(true) };
  assert.equal(ritualsForToday([cleaning], [log], '2026-11-23').length, 0);
});

test('Sunday returns both Sunday rituals, not overdue', () => {
  const out = ritualsForToday(R, [], '2026-11-29').filter((x) => !x.overdue);
  const names = out.map((x) => x.ritual.name).sort();
  assert.deepEqual(names, ['Budget day', 'Planning session']);
  for (const x of out) assert.equal(x.weekStart, '2026-11-23');
});

test('done ritual on its own day is still returned', () => {
  const log = { ritual_id: 'r0', week_start: '2026-11-23', done_at: 'x', checklist_state: [true, true, true, true] };
  const out = ritualsForToday(R, [log], '2026-11-29');
  assert.equal(out.find((x) => x.ritual.id === 'r0').done, true);
});

test('toggleItem', () => {
  assert.equal(toggleItem([true, true, true, false], 3, 4).done, true);
  assert.deepEqual(toggleItem([true, false], 0, 2), { state: [false, false], done: false });
  assert.deepEqual(toggleItem([], 1, 3).state, [false, true, false]);
});

test('default rituals verbatim', () => {
  assert.equal(cleaning.weekday, 6);
  assert.equal(cleaning.checklist.length, 8);
  assert.equal(cleaning.checklist[7], 'Recalibrate calories');
});
