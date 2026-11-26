import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../../js/lib/ticker.js';

function fakeTimers() {
  let id = 0;
  const live = new Map();
  return {
    setTimer: (fn, ms) => { live.set(++id, { fn, ms }); return id; },
    clearTimer: (h) => { live.delete(h); },
    fire: () => { for (const t of [...live.values()]) t.fn(); },
    count: () => live.size,
    ms: () => [...live.values()].map((t) => t.ms),
  };
}

test('ticker: paints at once, then once per interval (1000 ms)', () => {
  const t = fakeTimers();
  const out = [];
  const k = createTicker(() => out.push('x'), { setTimer: t.setTimer, clearTimer: t.clearTimer });
  k.start();
  assert.equal(out.length, 1);
  assert.deepEqual(t.ms(), [1000]);
  t.fire(); t.fire();
  assert.equal(out.length, 3);
});

test('ticker: start twice never makes a second interval; stop clears; stop twice is safe', () => {
  const t = fakeTimers();
  const k = createTicker(() => {}, { setTimer: t.setTimer, clearTimer: t.clearTimer });
  k.start(); k.start(); k.start();
  assert.equal(t.count(), 1);
  k.stop(); k.stop();
  assert.equal(t.count(), 0);
  k.start();
  assert.equal(t.count(), 1);
});

test('ticker: a throwing paint does not kill the interval or start()', () => {
  const t = fakeTimers();
  let n = 0;
  const k = createTicker(() => { n++; throw new Error('x'); }, { setTimer: t.setTimer, clearTimer: t.clearTimer });
  k.start();
  t.fire();
  assert.equal(n, 2);
  assert.equal(t.count(), 1);
});
