import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_START, GRID_END, gridStart, layoutDay } from '../../js/lib/timeline.js';

const t = (id, start, end) => ({ kind: 'event', id, title: id, label: id, start, end, allDay: false });
const allDay = (id) => ({ kind: 'event', id, title: id, label: id, start: null, end: null, allDay: true });
const brief = (rows) => Object.fromEntries(rows.map((r) => [r.item.id, { start: r.start, end: r.end, col: r.col, cols: r.cols }]));

test('constants', () => {
  assert.equal(GRID_START, 360);
  assert.equal(GRID_END, 1440);
});

test('gridStart default 360; earliest 05:40 → 300; untimed ignored', () => {
  assert.equal(gridStart([]), 360);
  assert.equal(gridStart([[], [t('a', 540, 600), allDay('x')]]), 360);
  assert.equal(gridStart([[t('a', 540, 600)], [t('b', 340, 400)]]), 300);
  assert.equal(gridStart([[allDay('x')]]), 360);
  assert.equal(gridStart([[t('m', 0, 30)]]), 0);
});

test('layoutDay side by side', () => {
  const r = brief(layoutDay([t('C', 630, 660), t('B', 570, 630), t('A', 540, 600)]));
  assert.deepEqual(r.A, { start: 540, end: 600, col: 0, cols: 2 });
  assert.deepEqual(r.B, { start: 570, end: 630, col: 1, cols: 2 });
  assert.deepEqual(r.C, { start: 630, end: 660, col: 0, cols: 1 });
});

test('layoutDay chain cluster', () => {
  const r = brief(layoutDay([t('A', 540, 600), t('B', 570, 660), t('C', 600, 690)]));
  assert.deepEqual(r.A, { start: 540, end: 600, col: 0, cols: 2 });
  assert.deepEqual(r.B, { start: 570, end: 660, col: 1, cols: 2 });
  assert.deepEqual(r.C, { start: 600, end: 690, col: 0, cols: 2 });
});

test('layoutDay clamps', () => {
  const r = brief(layoutDay([t('late', 1410, 1470), t('zero', 600, 600), t('neg', 700, 650), allDay('x')]));
  assert.equal(r.late.end, 1440);
  assert.equal(r.zero.end, 615);
  assert.equal(r.neg.end, 715);
  assert.equal(r.x, undefined, 'all-day items are not laid out');
});
