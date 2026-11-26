import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal fake DOM: enough for h(), SVG elements, document.body, focus and remove().
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super(); this.tag = tag; this.attrs = {}; this.listeners = {}; this.kids = []; this.className = ''; this.parent = null;
    this.styleMap = {}; this.style = { setProperty: (k, v) => { this.styleMap[k] = v; } };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  append(...n) { for (const c of n) { if (c instanceof FakeEl) c.parent = this; this.kids.push(c); } }
  remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); this.parent = null; }
  focus() { globalThis.document.activeElement = this; }
  querySelectorAll() { return []; }
}
class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }
const body = new FakeEl('body');
globalThis.Node = FakeNode;
globalThis.document = {
  body, activeElement: null,
  createElement: (t) => new FakeEl(t),
  createElementNS: (ns, t) => { const e = new FakeEl(t); e.ns = ns; return e; },
  createTextNode: (t) => new FakeText(t),
};
const C = await import('../../js/ui/components.js');
const text = (n) => (n instanceof FakeText ? n.text : n.kids.map(text).join(''));
const all = (n) => (n instanceof FakeEl ? [n, ...n.kids.flatMap(all)] : []);
const cls = (n, c) => all(n).filter((x) => x.className.split(' ').includes(c));

test('ringGeometry: 0.72 at defaults, ring math', () => {
  const g = C.ringGeometry({ value: 0.72 });
  assert.equal(g.r, 78);
  assert.ok(Math.abs(g.c - 490.088) < 0.001, String(g.c));
  assert.ok(Math.abs(g.offset - 137.225) < 0.001, String(g.offset));
});

test('ringGeometry clamps both sides of the 0..1 boundary and guards invalid input', () => {
  const hi = C.ringGeometry({ value: 1.4 });
  assert.equal(hi.offset, 0);
  assert.equal(C.ringGeometry({ value: 1 }).offset, 0);
  const lo = C.ringGeometry({ value: -1 });
  assert.equal(lo.offset, lo.c);
  assert.equal(C.ringGeometry({ value: 0 }).offset, C.ringGeometry({ value: 0 }).c);
  for (const bad of [NaN, undefined, null, Infinity, 'x']) {
    const g = C.ringGeometry({ value: bad });
    assert.ok(Number.isFinite(g.offset), String(bad));
    assert.ok(g.offset >= 0 && g.offset <= g.c);
  }
  const small = C.ringGeometry({ value: 0.5, size: 100, stroke: 10 });
  assert.equal(small.r, 45);
  const odd = C.ringGeometry({ value: 0.5, size: 10, stroke: 40 });
  assert.ok(odd.r > 0 && Number.isFinite(odd.c));
});

test('ring: role img with aria-label, number overlay, accent only when good', () => {
  const r = C.ring({ value0to1: 0.72, label: 'DAY SCORE', ariaLabel: 'Day score 72 of 100' });
  assert.equal(r.attrs.role, 'img');
  assert.equal(r.attrs['aria-label'], 'Day score 72 of 100');
  assert.match(text(r), /72/);
  assert.match(text(r), /DAY SCORE/);
  assert.ok(!r.className.split(' ').includes('is-good'));
  const circles = all(r).filter((x) => x.tag === 'circle');
  assert.equal(circles.length, 2);
  assert.ok(circles.some((c) => c.attrs.class === 'ring-track'));
  const fill = circles.find((c) => c.attrs.class === 'ring-fill');
  assert.ok(Math.abs(Number(fill.attrs['stroke-dashoffset']) - 137.225) < 0.001);
  assert.equal(fill.attrs['stroke-linecap'], 'round');
  const good = C.ring({ value0to1: 0.85, good: true });
  assert.ok(good.className.split(' ').includes('is-good'));
});

test('ring: out-of-range values still show a sane number', () => {
  assert.match(text(C.ring({ value0to1: 1.4 })), /100/);
  assert.match(text(C.ring({ value0to1: -2 })), /0/);
  assert.match(text(C.ring({ value0to1: NaN })), /0/);
});

test('bar: accent only at >= 1, invalid input is 0', () => {
  const half = C.bar(0.5);
  assert.equal(half.className.split(' ').includes('is-full'), false);
  assert.equal(cls(half, 'bar-fill')[0].styleMap.width, '50%');
  assert.ok(C.bar(1).className.split(' ').includes('is-full'));
  assert.ok(C.bar(3).className.split(' ').includes('is-full'));
  assert.equal(cls(C.bar(3), 'bar-fill')[0].styleMap.width, '100%');
  assert.equal(C.bar(0.999).className.split(' ').includes('is-full'), false);
  assert.equal(cls(C.bar(NaN), 'bar-fill')[0].styleMap.width, '0%');
  assert.equal(cls(C.bar(-1), 'bar-fill')[0].styleMap.width, '0%');
});

test('tile: button with label/value/unit and bar, 44px class, click handler', () => {
  let n = 0;
  const t = C.tile({ label: 'WATER', value: '1.5', unit: 'L', bar: 0.6, onClick: () => { n++; }, expanded: false });
  assert.equal(t.tag, 'button');
  assert.ok(t.className.split(' ').includes('tap'));
  assert.equal(t.attrs.type, 'button');
  assert.equal(t.attrs['aria-expanded'], 'false');
  assert.match(text(t), /WATER/);
  assert.match(text(t), /1\.5/);
  assert.match(text(t), /L/);
  assert.equal(cls(t, 'bar').length, 1);
  t.listeners.click[0]();
  assert.equal(n, 1);
  const plain = C.tile({ label: 'X', value: '1' });
  assert.equal(plain.tag, 'div');
  assert.equal(cls(plain, 'bar').length, 0);
});

test('trapTab wraps at both ends and handles an empty or foreign focus', () => {
  assert.equal(C.trapTab(3, 2, false), 0);
  assert.equal(C.trapTab(3, 0, true), 2);
  assert.equal(C.trapTab(3, 1, false), null);
  assert.equal(C.trapTab(3, 1, true), null);
  assert.equal(C.trapTab(3, -1, false), 0);
  assert.equal(C.trapTab(3, -1, true), 2);
  assert.equal(C.trapTab(0, -1, false), -1);
  assert.equal(C.trapTab(1, 0, false), 0);
});

test('sheet: dialog with title, Escape closes and restores focus, close is idempotent', () => {
  const opener = new FakeEl('button');
  document.activeElement = opener;
  let closed = 0;
  const s = C.sheet({ title: 'Pick one', body: 'Body text', actions: [], onClose: () => { closed++; } });
  const dlg = body.kids.find((k) => k.attrs?.role === 'dialog');
  assert.ok(dlg);
  assert.equal(dlg.attrs['aria-modal'], 'true');
  assert.equal(dlg.attrs['aria-label'], 'Pick one');
  assert.match(text(dlg), /Body text/);
  let prevented = false;
  dlg.listeners.keydown[0]({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.equal(closed, 1);
  assert.equal(body.kids.some((k) => k.attrs?.role === 'dialog'), false);
  assert.equal(document.activeElement, opener);
  s.close();
  assert.equal(closed, 1);
});

test('sheet: other keys leave it open; backdrop click closes', () => {
  let closed = 0;
  C.sheet({ title: 'T', body: 'b', onClose: () => { closed++; } });
  const dlg = body.kids.find((k) => k.attrs?.role === 'dialog');
  dlg.listeners.keydown[0]({ key: 'a', preventDefault() {} });
  assert.equal(closed, 0);
  const back = body.kids.find((k) => k.className === 'sheet-backdrop');
  back.listeners.click[0]();
  assert.equal(closed, 1);
});

test('undoToast: undo runs the callback once and dismisses; auto-dismisses after ms', async () => {
  let undone = 0;
  const t = C.undoToast('Added', () => { undone++; }, 5000);
  assert.equal(t.el.attrs.role, 'status');
  assert.match(text(t.el), /Added/);
  const btn = all(t.el).find((x) => x.tag === 'button');
  btn.listeners.click[0]();
  btn.listeners.click[0]();
  assert.equal(undone, 1);
  assert.equal(body.kids.includes(t.el), false);
  const t2 = C.undoToast('Soon gone', () => {}, 15);
  assert.ok(body.kids.includes(t2.el));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(body.kids.includes(t2.el), false);
  const t3 = C.undoToast('Default', () => {}, -5);
  t3.dismiss();
});

test('sheet: blocking ignores Escape and the backdrop; only close() ends it', () => {
  let closed = 0;
  const s = C.sheet({ title: 'Stuck', body: 'b', blocking: true, onClose: () => { closed++; } });
  const dlg = body.kids.find((k) => k.attrs?.role === 'dialog');
  let prevented = false;
  dlg.listeners.keydown[0]({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'Escape is swallowed so nothing behind it reacts');
  const back = body.kids.find((k) => k.className === 'sheet-backdrop');
  back.listeners.click?.[0]?.();
  assert.equal(closed, 0);
  assert.ok(body.kids.some((k) => k.attrs?.role === 'dialog'));
  s.close();
  assert.equal(closed, 1);
  assert.equal(body.kids.some((k) => k.attrs?.role === 'dialog'), false);
});
