import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal fake DOM so dom.js can be imported and h() exercised in node.
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
const { h } = await import('../../js/ui/dom.js');

test('h(): banned props rejected case-insensitively', () => {
  for (const k of ['style', 'STYLE', 'Style', 'innerHTML', 'innerhtml', 'INNERHTML', 'outerHTML', 'OuterHtml']) {
    assert.throws(() => h('div', { [k]: 'x' }), /not allowed/, k);
  }
});

test('h(): string-valued on* handlers throw, function handlers attach', () => {
  for (const k of ['onclick', 'onClick', 'ONCLICK', 'onerror', 'onload']) {
    assert.throws(() => h('div', { [k]: 'alert(1)' }), /handler/, k);
  }
  let n = 0;
  const a = h('button', { onClick: () => n++ });
  const b = h('button', { onclick: () => n++ });
  a.listeners.click[0](); b.listeners.click[0]();
  assert.equal(n, 2);
  assert.equal(a.attrs.onClick, undefined);
  assert.equal(b.attrs.onclick, undefined);
});

test('h(): normal props and text children', () => {
  const el = h('p', { class: 'muted', hidden: true, title: null }, 'a', 5, false, ['b']);
  assert.equal(el.className, 'muted');
  assert.equal(el.attrs.hidden, '');
  assert.equal('title' in el.attrs, false);
  assert.deepEqual(el.kids.map((k) => k.text), ['a', '5', 'b']);
});

test('longPress: holds fire after ms; cancel() stops a pending hold and later presses', async () => {
  const { longPress } = await import('../../js/ui/dom.js');
  const el = new FakeEl('button');
  const fire = (t) => el.listeners[t].forEach((f) => f({ clientX: 0, clientY: 0, pointerType: 'touch' }));
  let holds = 0;
  const lp = longPress(el, { ms: 20, onHold: () => { holds++; } });
  fire('pointerdown');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(holds, 1);
  fire('pointerdown');
  lp.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(holds, 1, 'cancelled before the threshold');
  fire('pointerdown');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(holds, 1, 'a cancelled handle stays dead');
});
