import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_PAST_DAYS, EVENT_FUTURE_DAYS, bootWindow, missingRange, addLoaded, mergeEvents, windowStatus,
} from '../../js/lib/event-window.js';

test('window constants and bootWindow', () => {
  assert.equal(EVENT_PAST_DAYS, 35);
  assert.equal(EVENT_FUTURE_DAYS, 90);
  assert.deepEqual(bootWindow('2026-11-26'), { from: '2026-10-22', to: '2027-02-24' });
});

test('missingRange', () => {
  const boot = [{ from: '2026-10-22', to: '2027-02-24' }];
  assert.equal(missingRange(boot, { from: '2026-11-01', to: '2026-11-30' }), null);
  assert.equal(missingRange(boot, { from: '2026-10-22', to: '2027-02-24' }), null);
  assert.deepEqual(missingRange(boot, { from: '2026-10-01', to: '2026-10-31' }), { from: '2026-10-01', to: '2026-10-21' });
  assert.deepEqual(missingRange(boot, { from: '2027-02-01', to: '2027-02-28' }), { from: '2027-02-25', to: '2027-02-28' });
  const two = [{ from: '2026-01-05', to: '2026-01-10' }];
  assert.deepEqual(missingRange(two, { from: '2026-01-01', to: '2026-01-15' }), { from: '2026-01-01', to: '2026-01-15' });
  const mid = [{ from: '2026-01-01', to: '2026-01-04' }, { from: '2026-01-08', to: '2026-01-09' }, { from: '2026-01-13', to: '2026-01-20' }];
  assert.deepEqual(missingRange(mid, { from: '2026-01-01', to: '2026-01-20' }), { from: '2026-01-05', to: '2026-01-12' });
  assert.deepEqual(missingRange([], { from: '2026-01-01', to: '2026-01-02' }), { from: '2026-01-01', to: '2026-01-02' });
});

test('addLoaded joins adjacent and overlapping ranges', () => {
  assert.deepEqual(addLoaded([{ from: '2026-10-22', to: '2027-02-24' }], { from: '2026-10-01', to: '2026-10-21' }),
    [{ from: '2026-10-01', to: '2027-02-24' }]);
  assert.deepEqual(addLoaded([{ from: '2026-01-01', to: '2026-01-10' }], { from: '2026-01-05', to: '2026-01-20' }),
    [{ from: '2026-01-01', to: '2026-01-20' }]);
  assert.deepEqual(addLoaded([{ from: '2026-03-01', to: '2026-03-05' }], { from: '2026-01-01', to: '2026-01-10' }),
    [{ from: '2026-01-01', to: '2026-01-10' }, { from: '2026-03-01', to: '2026-03-05' }]);
  const orig = [{ from: '2026-03-01', to: '2026-03-05' }];
  addLoaded(orig, { from: '2026-03-06', to: '2026-03-07' });
  assert.deepEqual(orig, [{ from: '2026-03-01', to: '2026-03-05' }]);
});

test('mergeEvents: snapshot wins by id', () => {
  const snap = [{ id: 'a', title: 'Edited', date: '2026-09-01' }, { id: 'b', title: 'B', date: '2026-11-26' }];
  const extra = [{ id: 'a', title: 'Stale', date: '2026-09-01' }, { id: 'c', title: 'C', date: '2026-09-02' }];
  const out = mergeEvents(snap, extra);
  assert.equal(out.length, 3);
  assert.equal(out.find((e) => e.id === 'a').title, 'Edited');
  assert.equal(out.filter((e) => e.id === 'a').length, 1);
  assert.ok(out.some((e) => e.id === 'c'));
});

test('windowStatus', () => {
  const loaded = [{ from: '2026-10-22', to: '2027-02-24' }];
  const inside = { from: '2026-11-01', to: '2026-11-30' };
  const outside = { from: '2026-09-01', to: '2026-09-30' };
  assert.equal(windowStatus({ loaded, want: inside, online: false, failed: false }), 'ok');
  assert.equal(windowStatus({ loaded, want: inside, online: true, failed: true }), 'ok');
  assert.equal(windowStatus({ loaded, want: outside, online: false, failed: false }), 'offline');
  assert.equal(windowStatus({ loaded, want: outside, online: true, failed: true }), 'failed');
  assert.equal(windowStatus({ loaded, want: outside, online: true, failed: false }), 'ok');
});
