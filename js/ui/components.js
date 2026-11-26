// Shared UI components: plain DOM/SVG, no libraries. Colours come from the CSS tokens via classes.
import { h } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const clamp01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  return el;
}

const sizeOf = (size) => (Number.isFinite(size) && size > 0 ? size : 168);
// A stroke wider than the box would give a negative radius: keep r > 0.
const strokeOf = (stroke, size) => (Number.isFinite(stroke) && stroke > 0 ? Math.min(stroke, size - 1) : Math.min(12, size - 1));

export function ringGeometry({ value, size = 168, stroke = 12 } = {}) {
  const sz = sizeOf(size);
  const st = strokeOf(stroke, sz);
  const r = (sz - st) / 2;
  const c = 2 * Math.PI * r;
  return { r, c, offset: c * (1 - clamp01(value)) };
}

// Progress ring: SVG track + fill, number as an HTML overlay (crisper than SVG text). The whole thing is one image
// to assistive tech (role="img" + aria-label); fill is --fg, --accent when `good`.
export function ring({ value0to1, size = 168, stroke = 12, label, ariaLabel, good = false, center, animate = false } = {}) {
  const sz = sizeOf(size);
  const st = strokeOf(stroke, sz);
  const g = ringGeometry({ value: value0to1, size: sz, stroke: st });
  const pct = Math.round(clamp01(value0to1) * 100);
  const mid = sz / 2;
  const grow = animate && typeof requestAnimationFrame === 'function';
  const fill = svgEl('circle', {
    class: 'ring-fill', cx: mid, cy: mid, r: g.r, fill: 'none', 'stroke-width': st, 'stroke-linecap': 'round',
    'stroke-dasharray': g.c, 'stroke-dashoffset': grow ? g.c : g.offset,
    transform: `rotate(-90 ${mid} ${mid})`,
  });
  if (grow) requestAnimationFrame(() => requestAnimationFrame(() => fill.setAttribute('stroke-dashoffset', String(g.offset))));
  const svg = svgEl('svg', { width: sz, height: sz, viewBox: `0 0 ${sz} ${sz}`, 'aria-hidden': 'true', focusable: 'false' });
  svg.append(svgEl('circle', { class: 'ring-track', cx: mid, cy: mid, r: g.r, fill: 'none', 'stroke-width': st }), fill);
  return h('div', { class: `ring${good ? ' is-good' : ''}`, role: 'img', 'aria-label': ariaLabel ?? `${label ?? 'Progress'} ${pct} percent` },
    svg,
    h('div', { class: 'ring-center', 'aria-hidden': 'true' },
      h('span', { class: 'ring-num num-display' }, center ?? String(pct)),
      label ? h('span', { class: 'cap' }, label) : null));
}

// 4px bar. Width is set through CSSOM (the CSP forbids style attributes); accent only when complete.
export function bar(value0to1) {
  const v = clamp01(value0to1);
  const fill = h('div', { class: 'bar-fill' });
  fill.style.setProperty('width', `${Math.round(v * 100)}%`);
  return h('div', { class: `bar${v >= 1 ? ' is-full' : ''}`, 'aria-hidden': 'true' }, fill);
}

// A stat tile. With onClick it is a real button (44px+ via .tap); without, a plain block.
export function tile({ label, value, unit, bar: progress, onClick, ariaLabel, expanded } = {}) {
  const kids = [
    h('span', { class: 'cap' }, label),
    h('span', { class: 'tile-value num' }, value, unit ? h('span', { class: 'tile-unit' }, ` ${unit}`) : null),
    progress === undefined || progress === null ? null : bar(progress),
  ];
  if (typeof onClick !== 'function') return h('div', { class: 'tile' }, ...kids);
  return h('button', {
    type: 'button', class: 'tap tile', 'aria-label': ariaLabel ?? `${label} ${value}${unit ? ` ${unit}` : ''}`,
    'aria-expanded': expanded === undefined ? null : String(!!expanded), onClick,
  }, ...kids);
}

// Which focusable index Tab should jump to, or null to let the browser move focus normally.
export function trapTab(count, index, shift) {
  if (count <= 0) return -1;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Bottom sheet: modal dialog, focus trapped, Escape or backdrop closes, focus returns to the opener.
// `blocking`: Escape and the backdrop do nothing; only its own buttons (via close()) end it.
// `onDismiss`: asked before Escape / the backdrop close it; returning false keeps it open.
export function sheet({ title, body, actions = [], onClose, onDismiss, blocking = false } = {}) {
  const opener = document.activeElement;
  let open = true;
  let dialog = null;
  let backdrop = null;
  const close = () => {
    if (!open) return;
    open = false;
    dialog.remove();
    backdrop.remove();
    try { opener?.focus?.(); } catch { /* the opener may be gone after a re-render */ }
    onClose?.();
  };
  const dismiss = () => { if (onDismiss && onDismiss() === false) return; close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); if (!blocking) dismiss(); return; }
    if (e.key !== 'Tab') return;
    const list = [...dialog.querySelectorAll(FOCUSABLE)];
    const next = trapTab(list.length, list.indexOf(document.activeElement), !!e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    (list[next] ?? dialog).focus();
  };
  backdrop = h('div', { class: 'sheet-backdrop', onClick: blocking ? null : dismiss });
  dialog = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1', onKeydown: onKey },
    h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
    h('h2', { class: 'sheet-title' }, title),
    h('div', { class: 'sheet-body' }, body),
    actions.length ? h('div', { class: 'sheet-actions' }, actions) : null);
  document.body.append(backdrop, dialog);
  const first = dialog.querySelectorAll(FOCUSABLE)[0];
  (first ?? dialog).focus();
  return { el: dialog, close };
}

// Short-lived toast with one Undo button. Undo runs once; it disappears after `ms` (default 5 s).
export function undoToast(text, onUndo, ms = 5000) {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : 5000;
  let gone = false;
  let timer = null;
  let el = null;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.remove();
  };
  el = h('div', { class: 'toast', role: 'status' },
    h('span', { class: 'grow' }, text),
    h('button', { type: 'button', class: 'tap link', onClick: () => { if (gone) return; dismiss(); onUndo?.(); } }, 'Undo'));
  document.body.append(el);
  timer = setTimeout(dismiss, wait);
  return { el, dismiss };
}
