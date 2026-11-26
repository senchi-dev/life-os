import test from 'node:test';
import assert from 'node:assert/strict';
import { isTyping, watchSwUpdate } from '../../js/lib/sw-update.js';

function fakeTarget() {
  const handlers = {};
  return {
    handlers,
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
    fire(type) { for (const fn of handlers[type] ?? []) fn(); },
  };
}

function setup({ controller = {}, active = { tagName: 'BODY' }, visibility = 'visible' } = {}) {
  const sw = Object.assign(fakeTarget(), { controller });
  const doc = Object.assign(fakeTarget(), { activeElement: active, visibilityState: visibility });
  let reloads = 0;
  watchSwUpdate(sw, doc, () => { reloads++; });
  return { sw, doc, reloads: () => reloads };
}

test('isTyping: inputs, textareas, selects and contenteditable count as typing', () => {
  assert.equal(isTyping({ tagName: 'INPUT' }), true);
  assert.equal(isTyping({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTyping({ tagName: 'SELECT' }), true);
  assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: 'BUTTON' }), false);
  assert.equal(isTyping({ tagName: 'BODY' }), false);
  assert.equal(isTyping(null), false);
});

test('a new version taking over reloads once when nothing is being typed', () => {
  const t = setup();
  t.sw.fire('controllerchange');
  t.sw.fire('controllerchange');
  assert.equal(t.reloads(), 1);
});

test('first install (no controller at boot) never reloads', () => {
  const t = setup({ controller: null });
  t.sw.fire('controllerchange');
  assert.equal(t.reloads(), 0);
});

test('while typing, the reload waits until the app is hidden', () => {
  const t = setup({ active: { tagName: 'INPUT' } });
  t.sw.fire('controllerchange');
  assert.equal(t.reloads(), 0);
  t.doc.fire('visibilitychange');
  assert.equal(t.reloads(), 0, 'still visible: no reload');
  t.doc.visibilityState = 'hidden';
  t.doc.fire('visibilitychange');
  assert.equal(t.reloads(), 1);
  t.doc.fire('visibilitychange');
  assert.equal(t.reloads(), 1, 'only once');
});

test('a hidden app reloads at once', () => {
  const t = setup({ active: { tagName: 'INPUT' }, visibility: 'hidden' });
  t.sw.fire('controllerchange');
  assert.equal(t.reloads(), 1);
});

test('missing service worker container is a no-op', () => {
  assert.doesNotThrow(() => watchSwUpdate(undefined, {}, () => {}));
});
