import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT_KEY, LAYOUTS, readLayout, writeLayout, applyLayout, currentLayout } from '../../js/lib/layout.js';

test('readLayout', () => {
  assert.equal(LAYOUT_KEY, 'lifeos-layout');
  assert.deepEqual(LAYOUTS, ['list', 'tiles', 'big']);
  assert.equal(readLayout({ getItem: () => 'tiles' }), 'tiles');
  assert.equal(readLayout({ getItem: () => 'big' }), 'big');
  assert.equal(readLayout({ getItem: () => 'grid' }), 'list');
  assert.equal(readLayout({ getItem: () => null }), 'list');
  assert.equal(readLayout({ getItem: () => { throw new Error('x'); } }), 'list');
  assert.equal(readLayout(undefined), 'list');
});

test('writeLayout', () => {
  const store = {};
  const s = { setItem: (k, v) => { store[k] = v; } };
  assert.equal(writeLayout(s, 'big'), true);
  assert.equal(store[LAYOUT_KEY], 'big');
  delete store[LAYOUT_KEY];
  assert.equal(writeLayout(s, 'grid'), false);
  assert.equal(LAYOUT_KEY in store, false);
  assert.equal(writeLayout({ setItem: () => { throw new Error('x'); } }, 'tiles'), false);
});

test('applyLayout sets data-layout', () => {
  const el = { dataset: {} };
  applyLayout(el, 'tiles');
  assert.equal(el.dataset.layout, 'tiles');
});

test('currentLayout prefers the applied attribute so blocked storage still shows the choice', () => {
  const blocked = { getItem() { throw new Error('blocked'); } };
  assert.equal(currentLayout({ dataset: { layout: 'big' } }, blocked), 'big');
  assert.equal(currentLayout({ dataset: {} }, blocked), 'list');
  assert.equal(currentLayout({ dataset: { layout: 'bogus' } }, { getItem: () => 'tiles' }), 'tiles');
});
