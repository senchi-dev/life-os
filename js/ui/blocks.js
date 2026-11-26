// Semantic blocks: screens say what they show (a section, metrics, a status row), the layout decides how.
// Same actions in every layout; only markup/presentation differs. Classes live in css/layouts.css.
import { h } from './dom.js';
import { ring, bar } from './components.js';
import { LAYOUTS } from '../lib/layout.js';

export const STATUS_WORDS = { done: 'Done', todo: 'To do', skipped: 'Skipped' };

// The layout applied on <html data-layout> (set at boot and by Settings); anything else reads as 'list'.
export function layoutNow() {
  const v = globalThis.document?.documentElement?.dataset?.layout;
  return LAYOUTS.includes(v) ? v : 'list';
}

const pick = (layout) => (LAYOUTS.includes(layout) ? layout : layoutNow());
const valueText = (value, unit) => `${value ?? ''}${unit ? ` ${unit}` : ''}`;
const expandedAttr = (expanded) => (typeof expanded === 'boolean' ? String(expanded) : null);

// Label on the left; with a sub line the two stack in a growing column.
function labelPart(label, sub, lang) {
  const main = h('span', { class: 'ellip', lang: lang ?? null }, label);
  if (sub == null || sub === '') return main;
  return h('span', { class: 'grow' }, main, h('span', { class: 'blk-sub' }, sub));
}

export function section({ title, count, aside, id } = {}, ...children) {
  const heading = h('h2', { class: 'sec-title' }, count == null ? title : `${title} · ${count}`);
  return h('section', { class: 'blk-sec', 'aria-label': title, id: id ?? null },
    aside ? h('div', { class: 'thead' }, heading, aside) : heading,
    ...children);
}

export function list(...rows) {
  return h('div', { class: 'blk-list' }, ...rows);
}

function metricTile({ key, label, value, unit, progress, onClick, ariaLabel, expanded }) {
  const kids = [
    h('span', { class: 'ellip' }, label),
    h('span', { class: 'num blk-val' }, value, unit ? h('span', { class: 'tile-unit' }, ` ${unit}`) : null),
    typeof progress === 'number' ? bar(progress) : null,
  ];
  if (typeof onClick !== 'function') return h('div', { class: 'blk-tile', 'data-key': key ?? null }, ...kids);
  return h('button', {
    type: 'button', class: 'tap blk-tile', 'data-key': key ?? null,
    'aria-label': ariaLabel ?? `${label} ${valueText(value, unit)}`, 'aria-expanded': expandedAttr(expanded), onClick,
  }, ...kids);
}

function metricRow({ key, label, value, unit, onClick, ariaLabel, expanded }) {
  const kids = [h('span', { class: 'ellip' }, label), h('span', { class: 'num blk-val' }, valueText(value, unit))];
  if (typeof onClick !== 'function') return h('div', { class: 'blk-row', 'data-key': key ?? null }, ...kids);
  return h('button', {
    type: 'button', class: 'tap blk-row', 'data-key': key ?? null,
    'aria-label': ariaLabel ?? `${label} ${valueText(value, unit)}`, 'aria-expanded': expandedAttr(expanded), onClick,
  }, ...kids);
}

// Metric items: tiles grid (big number + bar) in Tiles, label/value rows in List and Big.
export function metrics(items = [], { layout } = {}) {
  const l = pick(layout);
  if (l === 'tiles') return h('div', { class: 'blk-tiles' }, items.map(metricTile));
  return h('div', { class: l === 'big' ? 'blk-list blk-big' : 'blk-list' }, items.map(metricRow));
}

// A thing with a state, said in words ("Done", "To do", "Skipped"); an optional glyph is decoration only.
export function statusRow({ label, status, sub, ariaLabel, onClick, button, glyph } = {}) {
  const word = STATUS_WORDS[status] ?? String(status ?? '');
  const kids = [
    labelPart(label, sub),
    h('span', { class: `blk-status is-${status}` }, glyph ? h('span', { 'aria-hidden': 'true' }, glyph) : null, word),
  ];
  if (typeof onClick === 'function' || button) {
    return h('button', { type: 'button', class: 'tap blk-row', 'aria-label': ariaLabel ?? null, onClick: typeof onClick === 'function' ? onClick : null }, ...kids);
  }
  return h('div', { class: 'blk-row' }, ...kids);
}

// Label left, value right; a link (with chevron) when href, a button when onClick.
export function valueRow({ label, value, sub, href, onClick, ariaLabel, lang } = {}) {
  const kids = [labelPart(label, sub, lang), h('span', { class: 'num blk-val' }, value)];
  if (href) {
    return h('a', { class: 'tap blk-row', href, 'aria-label': ariaLabel ?? null },
      ...kids, h('span', { class: 'blk-sub', 'aria-hidden': 'true' }, '›'));
  }
  if (typeof onClick === 'function') return h('button', { type: 'button', class: 'tap blk-row', 'aria-label': ariaLabel ?? null, onClick }, ...kids);
  return h('div', { class: 'blk-row' }, ...kids);
}

// Day score (0..100): the ring in List and Tiles, a big numeral in Big; the label captions both.
export function score({ value, good = false, ariaLabel, animate = false, label, layout } = {}) {
  const n = Number.isFinite(value) ? Math.round(value) : 0;
  const aria = ariaLabel ?? `Score ${n} of 100`;
  if (pick(layout) !== 'big') return ring({ value0to1: n / 100, label, ariaLabel: aria, good, animate });
  return h('div', { class: `blk-score${good ? ' is-good' : ''}`, role: 'img', 'aria-label': aria },
    h('span', { class: 'blk-score-num' }, String(n)),
    label ? h('span', { class: 'blk-score-cap' }, label) : null);
}
