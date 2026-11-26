import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPager, beginPage, pageDone, pageFailed, hasMore, resetPager, pagerRows } from '../../js/ui/pager.js';

const row = (id) => ({ session: { workoutId: id } });
const rows = (a, b) => Array.from({ length: b - a }, (_, i) => row(`w${a + i}`));

test('pager: pages accumulate; hasMore false once everything is loaded (and for a total of 0)', () => {
  const p = newPager(20);
  assert.equal(hasMore(p, 45), true);
  for (const [a, b] of [[0, 20], [20, 40], [40, 45]]) { const t = beginPage(p); assert.ok(t); pageDone(p, t, rows(a, b)); }
  assert.equal(pagerRows(p).length, 45);
  assert.equal(hasMore(p, 45), false);
  assert.equal(hasMore(newPager(20), 0), false);
  assert.equal(hasMore(newPager(20), 20), true, 'nothing loaded yet');
  const q = newPager(20); pageDone(q, beginPage(q), rows(0, 20));
  assert.equal(hasMore(q, 20), false, 'exact multiple: no phantom page');
});

test('pager: double tap fetches once (in-flight guard)', () => {
  const p = newPager(20);
  const t1 = beginPage(p);
  assert.ok(t1);
  assert.equal(beginPage(p), null);
  pageDone(p, t1, rows(0, 20));
  assert.ok(beginPage(p), 'free again after the result');
});

test('pager: an error keeps loaded pages, shows the error, allows a retry that clears it', () => {
  const p = newPager(20);
  pageDone(p, beginPage(p), rows(0, 20));
  const t = beginPage(p);
  assert.equal(pageFailed(p, t), true);
  assert.equal(p.error, true);
  assert.equal(pagerRows(p).length, 20, 'earlier pages survive');
  assert.equal(hasMore(p, 45), true, 'Load more / Try again stays available');
  const r = beginPage(p);
  assert.ok(r);
  assert.equal(p.error, false);
  pageDone(p, r, rows(20, 40));
  assert.equal(pagerRows(p).length, 40);
});

test('pager: a stale result (after reset) is ignored and cannot unlock a newer request', () => {
  const p = newPager(20);
  const old = beginPage(p);
  resetPager(p);
  assert.equal(p.loading, false);
  const fresh = beginPage(p);
  assert.equal(pageDone(p, old, rows(0, 20)), false);
  assert.equal(pagerRows(p).length, 0);
  assert.equal(p.loading, true, 'the new request is still in flight');
  assert.equal(pageFailed(p, old), false);
  assert.equal(p.error, false);
  assert.equal(pageDone(p, fresh, rows(0, 20)), true);
  assert.equal(pagerRows(p).length, 20);
});

test('pager: duplicate workouts across pages (offsets shifted) are not repeated', () => {
  const p = newPager(20);
  pageDone(p, beginPage(p), rows(0, 20));
  pageDone(p, beginPage(p), rows(19, 39));
  const ids = pagerRows(p).map((r) => r.session.workoutId);
  assert.equal(ids.length, 39);
  assert.equal(new Set(ids).size, 39);
});

test('pager: a short page ends the list even if the total says more', () => {
  const p = newPager(20);
  pageDone(p, beginPage(p), rows(0, 7));
  assert.equal(hasMore(p, 45), false);
});

import { leaveTracker } from '../../js/ui/pager.js';
test('leaveTracker: a repaint (cleanup then enter) is not a leave; a cleanup alone is', async () => {
  let left = 0;
  const t = leaveTracker(() => { left++; });
  t.cleanup(); t.enter();
  await Promise.resolve();
  assert.equal(left, 0);
  t.cleanup();
  await Promise.resolve();
  assert.equal(left, 1);
  t.cleanup(); t.cleanup(); t.enter();
  await Promise.resolve();
  assert.equal(left, 1);
});
