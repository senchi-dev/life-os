import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrence, ritualsForToday, ritualState, toggleItem, DEFAULT_RITUALS } from '../../js/lib/rituals.js';

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

const ITEMS = ['A', 'B'];
test('ritualState: legacy array is read positionally', () => {
  assert.deepEqual(ritualState({ checklist: ITEMS }, { checklist_state: [true, false] }), [true, false]);
  assert.deepEqual(ritualState({ checklist: ITEMS }, { checklist_state: [true] }), [true, false]);
});

test('ritualState: object form follows the item text, not the position', () => {
  assert.deepEqual(ritualState({ checklist: ['B', 'A'] }, { checklist_state: { A: true } }), [false, true]);
  assert.deepEqual(ritualState({ checklist: ['A2', 'B'] }, { checklist_state: { A: true } }), [false, false]);
});

test('ritualState: missing, null or malformed state is all unticked', () => {
  for (const log of [undefined, null, {}, { checklist_state: null }, { checklist_state: 'x' }, { checklist_state: 5 }]) {
    assert.deepEqual(ritualState({ checklist: ITEMS }, log), [false, false], JSON.stringify(log));
  }
  assert.deepEqual(ritualState({ checklist: [] }, { checklist_state: [true] }), []);
});

test('ritualsForToday uses ritualState for the object form', () => {
  const log = { ritual_id: cleaning.id, week_start: '2026-11-16', done_at: null, checklist_state: { [cleaning.checklist[2]]: true } };
  const out = ritualsForToday([cleaning], [log], '2026-11-23');
  assert.deepEqual(out[0].state, cleaning.checklist.map((_, i) => i === 2));
});

test('toggleItem returns the object form and done when all items are ticked', () => {
  const r = toggleItem([true, false], 1, ITEMS);
  assert.deepEqual(r, { state: { A: true, B: true }, done: true });
  assert.deepEqual(toggleItem([true, true], 0, ITEMS), { state: { A: false, B: true }, done: false });
  assert.deepEqual(toggleItem([], 1, ['A', 'B', 'C']).state, { A: false, B: true, C: false });
});

test('toggleItem guards an out-of-range index and an empty list', () => {
  assert.deepEqual(toggleItem([true, false], 5, ITEMS), { state: { A: true, B: false }, done: false });
  assert.deepEqual(toggleItem([true, false], -1, ITEMS), { state: { A: true, B: false }, done: false });
  assert.deepEqual(toggleItem([true, false], 1.5, ITEMS), { state: { A: true, B: false }, done: false });
  assert.deepEqual(toggleItem([], 0, []), { state: {}, done: false });
});

test('default rituals verbatim', () => {
  assert.equal(cleaning.weekday, 6);
  assert.equal(cleaning.checklist.length, 8);
  assert.equal(cleaning.checklist[7], 'Recalibrate calories');
});
