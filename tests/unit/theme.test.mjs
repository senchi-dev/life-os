import test from 'node:test';
import assert from 'node:assert/strict';
import { THEME_KEY, readTheme, writeTheme, applyTheme, themeColor } from '../../js/lib/theme.js';

test('readTheme', () => {
  assert.equal(THEME_KEY, 'lifeos-theme');
  assert.equal(readTheme({ getItem: () => 'light' }), 'light');
  assert.equal(readTheme({ getItem: () => 'system' }), 'system');
  assert.equal(readTheme({ getItem: () => 'blue' }), 'dark');
  assert.equal(readTheme({ getItem: () => null }), 'dark');
  assert.equal(readTheme({ getItem: () => { throw new Error('x'); } }), 'dark');
  assert.equal(readTheme(undefined), 'dark');
});

test('writeTheme', () => {
  const store = {};
  assert.equal(writeTheme({ setItem: (k, v) => { store[k] = v; } }, 'light'), true);
  assert.equal(store[THEME_KEY], 'light');
  assert.equal(writeTheme({ setItem: () => { throw new Error('x'); } }, 'light'), false);
});

test('applyTheme and themeColor', () => {
  const el = { dataset: {} };
  applyTheme(el, 'light');
  assert.equal(el.dataset.theme, 'light');
  assert.equal(themeColor('system', true), '#f5f6f7');
  assert.equal(themeColor('system', false), '#0b0c0e');
  assert.equal(themeColor('dark', true), '#0b0c0e');
  assert.equal(themeColor('light', false), '#f5f6f7');
});

import { currentTheme, watchSystemTheme } from '../../js/lib/theme.js';

test('currentTheme prefers the applied attribute so blocked storage still shows the choice', () => {
  const blocked = { getItem() { throw new Error('blocked'); } };
  assert.equal(currentTheme({ dataset: { theme: 'light' } }, blocked), 'light');
  assert.equal(currentTheme({ dataset: {} }, blocked), 'dark');
  assert.equal(currentTheme({ dataset: { theme: 'bogus' } }, { getItem: () => 'system' }), 'system');
});

test('watchSystemTheme updates theme-color on OS change only while theme is system', () => {
  let listener = null;
  const mq = { matches: false, addEventListener: (_t, fn) => { listener = fn; } };
  let theme = 'system';
  const seen = [];
  watchSystemTheme(mq, () => theme, (color) => seen.push(color));
  mq.matches = true; listener();
  theme = 'dark'; listener();
  theme = 'system'; mq.matches = false; listener();
  assert.deepEqual(seen, ['#f5f6f7', '#0b0c0e']);
  assert.doesNotThrow(() => watchSystemTheme(undefined, () => 'system', () => {}));
  assert.doesNotThrow(() => watchSystemTheme({}, () => 'system', () => {}));
});
