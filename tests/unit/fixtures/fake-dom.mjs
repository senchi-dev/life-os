// Minimal shared fake DOM for unit tests: enough for h(), SVG elements, document.body, focus, remove(),
// dataset, classList.contains and <html data-layout>. Call installFakeDom() before importing UI modules.
class FakeNode {}

export class FakeEl extends FakeNode {
  constructor(tag) {
    super(); this.tag = tag; this.attrs = {}; this.listeners = {}; this.kids = []; this.className = ''; this.parent = null;
    this.dataset = {};
    this.styleMap = {}; this.style = { setProperty: (k, v) => { this.styleMap[k] = v; } };
    const el = this;
    this.classList = {
      contains: (c) => String(el.className || el.attrs.class || '').split(/\s+/).includes(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  append(...n) { for (const c of n) { if (c instanceof FakeEl) c.parent = this; this.kids.push(c); } }
  remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); this.parent = null; }
  focus() { globalThis.document.activeElement = this; }
  querySelectorAll() { return []; }
}

export class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }

export function installFakeDom() {
  const body = new FakeEl('body');
  globalThis.Node = FakeNode;
  globalThis.document = {
    body, activeElement: null,
    documentElement: new FakeEl('html'),
    createElement: (t) => new FakeEl(t),
    createElementNS: (ns, t) => { const e = new FakeEl(t); e.ns = ns; return e; },
    createTextNode: (t) => new FakeText(t),
  };
  return { body, FakeEl, FakeText };
}

export const text = (n) => (n instanceof FakeText ? n.text : n.kids.map(text).join(''));
export const all = (n) => (n instanceof FakeEl ? [n, ...n.kids.flatMap(all)] : []);
export const byClass = (n, c) => all(n).filter((x) => x.classList.contains(c));
