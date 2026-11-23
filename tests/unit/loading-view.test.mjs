import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.listeners = {}; this.kids = []; this.className = ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  append(...n) { this.kids.push(...n); }
}
class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };
const { loadingNodes } = await import('../../js/ui/loading.js');
const text = (n) => (n instanceof FakeText ? n.text : n.kids.map(text).join(''));

test('R5: while loading it says Loading with no button', () => {
  const nodes = loadingNodes({ loadFailed: false, refresh: () => {} });
  assert.equal(nodes.map(text).join(' '), 'Loading…');
});

test('R5: after a failed first load it offers a calm Retry button wired to refresh', () => {
  let n = 0;
  const nodes = loadingNodes({ loadFailed: true, refresh: () => { n++; return Promise.reject(new Error('x')); } });
  assert.match(nodes.map(text).join(' '), /Could not load data\. Retry/);
  const btn = nodes.flatMap((x) => [x, ...x.kids]).find((x) => x.tag === 'button');
  assert.ok(btn.className.split(' ').includes('tap'), 'tap class gives 44px');
  btn.listeners.click[0]();
  assert.equal(n, 1);
});
