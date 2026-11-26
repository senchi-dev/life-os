import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardedStart } from '../../js/ui/start-guard.js';

test('guardedStart: disabled while running, stays disabled on success, a second tap is ignored', async () => {
  const btn = { disabled: false };
  let n = 0;
  const p = guardedStart(btn, async () => { n++; return true; });
  assert.equal(btn.disabled, true);
  assert.equal(await guardedStart(btn, async () => { n++; return true; }), null);
  assert.equal(await p, true);
  assert.equal(btn.disabled, true);
  assert.equal(n, 1);
});

test('guardedStart: re-enables after a failed start (null/false result or a throw)', async () => {
  for (const fn of [async () => null, async () => false, async () => { throw new Error('x'); }]) {
    const btn = { disabled: false };
    const r = await guardedStart(btn, fn);
    assert.equal(r, false);
    assert.equal(btn.disabled, false);
  }
});
