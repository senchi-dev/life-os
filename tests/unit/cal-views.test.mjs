import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, text, byClass } from './fixtures/fake-dom.mjs';

installFakeDom();
const V = await import('../../js/ui/cal-views.js');
const { formDate } = await import('../../js/ui/calendar-view.js');

const click = (el) => { for (const fn of el.listeners.click ?? []) fn({ preventDefault() {} }); };

test('blockGeometry: 09:00–10:00, col 1 of 2, grid from 06:00', () => {
  assert.equal(V.HOUR_PX, 48);
  assert.deepEqual(V.blockGeometry({ start: 540, end: 600, col: 1, cols: 2 }, 360), { top: 144, height: 48, left: 50, width: 50 });
});

test('formDate: day and month use the anchor, agenda and week do not', () => {
  assert.equal(formDate('day', '2026-12-03', '2026-11-26'), '2026-12-03');
  assert.equal(formDate('month', '2026-12-03', '2026-11-26'), '2026-12-03');
  assert.equal(formDate('agenda', '2026-12-03', '2026-11-26'), null);
  assert.equal(formDate('week', '2026-12-03', '2026-11-26'), null);
});

const PLANNED = { kind: 'gym', id: null, title: 'Upper A', label: 'Upper A · planned', start: null, end: null, allDay: true, state: 'planned', href: '#/gym' };
const EVENT = { kind: 'event', id: 'e1', title: 'Dentist', label: 'Dentist', start: 600, end: 660, allDay: false };

function dayCtx(anchor, todayKey, calls) {
  return {
    anchor, todayKey, byDay: new Map([[anchor, [PLANNED, EVENT]]]),
    onSelectEvent: (e) => calls.push(['select', e]), onOpenDay: () => {}, onSelectDay: () => {},
    onStep: (d) => calls.push(['step', d]), onToday: () => calls.push(['today']),
  };
}

test('renderDay: all-day strip, one event block, now line on today only, taps', () => {
  const calls = [];
  const el = V.renderDay({}, dayCtx('2026-11-26', '2026-11-26', calls));
  const strip = byClass(el, 'cal-allday');
  assert.equal(strip.length, 1);
  assert.match(text(strip[0]), /Upper A · planned/);
  const blocks = byClass(el, 'cal-block').filter((b) => b.classList.contains('is-event'));
  assert.equal(blocks.length, 1);
  assert.equal(byClass(el, 'cal-now').length, 1);

  click(blocks[0]);
  assert.deepEqual(calls.at(-1), ['select', EVENT]);
  click(byClass(el, 'cal-title')[0]);
  assert.deepEqual(calls.at(-1), ['today']);

  const other = V.renderDay({}, dayCtx('2026-11-27', '2026-11-26', []));
  assert.equal(byClass(other, 'cal-now').length, 0);
});

test('renderDay: block geometry goes through style.setProperty', () => {
  const el = V.renderDay({}, dayCtx('2026-11-27', '2026-11-26', []));
  const block = byClass(el, 'cal-block')[0];
  assert.equal(block.styleMap.top, '192px'); // 10:00 from a 06:00 grid
  assert.equal(block.styleMap.height, '48px');
  assert.equal(block.attrs.style, undefined);
});

// Week / Month (Task 13).
const { h } = await import('../../js/ui/dom.js');
const { calItemRow } = await import('../../js/ui/calendar-view.js');
const { KINDS } = await import('../../js/lib/cal-items.js');

const RITUAL = { kind: 'ritual', id: 'r1', title: 'Read', label: 'Read', start: 1260, end: 1290, allDay: false };
const EARLY = { kind: 'event', id: 'e2', title: 'Run', label: 'Run', start: 315, end: 375, allDay: false };

function rangeCtx(anchor, todayKey, days, calls) {
  return {
    anchor, todayKey, byDay: new Map(days),
    onSelectEvent: (e) => calls.push(['select', e]), onOpenDay: (k) => calls.push(['open', k]), onSelectDay: (k) => calls.push(['day', k]),
    onStep: (d) => calls.push(['step', d]), onToday: () => calls.push(['today']),
    agendaRow: (it) => h('div', { class: 'citem' }, it.label),
  };
}

const WEEK = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'];

test('renderWeek: 7 Monday-first day columns, today marked, one button each opening Day view', () => {
  const calls = [];
  const days = WEEK.map((k) => [k, k === '2026-11-26' ? [PLANNED, EVENT, RITUAL] : []]);
  const el = V.renderWeek({}, rangeCtx('2026-11-26', '2026-11-26', days, calls));
  const cols = byClass(el, 'cal-wcol');
  assert.equal(cols.length, 7);
  assert.deepEqual(cols.map((c) => c.attrs['data-date']), WEEK);
  assert.ok(cols.every((c) => c.tag === 'button'));
  assert.deepEqual(cols.map((c) => c.classList.contains('is-today')), [false, false, false, true, false, false, false]);
  assert.match(cols[3].attrs['aria-label'], /Thu 26 Nov.*3 items/);
  assert.match(cols[0].attrs['aria-label'], /Mon 23 Nov.*0 items/);
  click(cols[3]);
  assert.deepEqual(calls.at(-1), ['open', '2026-11-26']);

  // Blocks are bars: no buttons/links inside a column, text only in the optional start-time span.
  const blocks = byClass(cols[3], 'cal-wblock');
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.ok(b.kids.every((k) => k.classList?.contains('cal-btime')));
    assert.equal(b.attrs.style, undefined);
  }
  assert.ok(blocks[0].classList.contains('is-event'));
  assert.equal(blocks[0].styleMap.top, '192px');
  assert.equal(text(blocks[0]), '10:00');
  assert.deepEqual(byClass(cols[3], 'tap'), [cols[3]]);

  // All-day strip shows planned gym labels.
  const allday = byClass(cols[3], 'cal-wallday')[0];
  assert.match(text(allday), /Upper A · planned/);

  click(byClass(el, 'cal-step')[0]);
  assert.deepEqual(calls.at(-1), ['step', -1]);
});

test('renderWeek: one item at 05:15 starts the whole week grid at 05:00', () => {
  const days = WEEK.map((k) => [k, k === '2026-11-25' ? [EARLY] : k === '2026-11-27' ? [EVENT] : []]);
  const el = V.renderWeek({}, rangeCtx('2026-11-26', '2026-11-26', days, []));
  const labels = byClass(el, 'cal-hourlabel').map(text);
  assert.equal(labels[0], '05:00');
  assert.equal(labels.at(-1), '23:00');
  const fri = byClass(el, 'cal-wcol')[4];
  assert.equal(byClass(fri, 'cal-wblock')[0].styleMap.top, '240px'); // 10:00 from a 05:00 grid
});

test('renderMonth: 6 rows for March 2026, out-of-month cells, dots in KINDS order, select day, agenda rows', () => {
  const calls = [];
  const grid = [];
  for (let d = 0; d < 42; d++) {
    const k = new Date(Date.UTC(2026, 1, 23 + d)).toISOString().slice(0, 10);
    grid.push([k, k === '2026-03-10' ? [EVENT, { ...PLANNED }] : []]);
  }
  const el = V.renderMonth({}, rangeCtx('2026-03-15', '2026-03-12', grid, calls));
  assert.match(text(byClass(el, 'cal-title')[0]), /March 2026/);
  assert.equal(byClass(el, 'cal-mweek').length, 6);
  const cells = byClass(el, 'cal-mday');
  assert.equal(cells.length, 42);
  assert.ok(cells[0].classList.contains('is-out')); // Mon 23 Feb
  assert.ok(!cells[6].classList.contains('is-out')); // Sun 1 Mar
  assert.ok(cells[41].classList.contains('is-out')); // Sun 5 Apr
  const today = cells.find((c) => c.attrs['data-date'] === '2026-03-12');
  assert.ok(today.classList.contains('is-today'));
  const sel = cells.find((c) => c.attrs['data-date'] === '2026-03-15');
  assert.ok(sel.classList.contains('is-selected'));
  assert.equal(sel.attrs['aria-pressed'], 'true');

  const busy = cells.find((c) => c.attrs['data-date'] === '2026-03-10');
  const dots = byClass(busy, 'cal-dot');
  assert.deepEqual(dots.map((d) => KINDS.find((k) => d.classList.contains(`is-${k}`))), ['gym', 'event']);
  assert.match(busy.attrs['aria-label'], /Tue 10 Mar.*gym.*events/);
  click(busy);
  assert.deepEqual(calls.at(-1), ['day', '2026-03-10']);

  // Selected day (the anchor) has nothing; the busy day selected shows its items as Agenda rows.
  assert.match(text(byClass(el, 'cal-mlist')[0]), /Nothing planned/);
  const el2 = V.renderMonth({}, rangeCtx('2026-03-10', '2026-03-12', grid, []));
  const rows = byClass(byClass(el2, 'cal-mlist')[0], 'citem');
  assert.equal(rows.length, 2);
  assert.ok(byClass(el2, 'blk-list').length === 1);
});

test('calItemRow: calendar items become the Agenda rows', () => {
  const app = { rerender() {} };
  const e = { id: 'e1', title: 'Dentist', date: '2026-11-26', start_time: '10:00:00', end_time: '11:00:00', location: 'Rue X' };
  const byId = new Map([[e.id, e]]);
  const ev = calItemRow(app, EVENT, byId);
  assert.ok(ev.classList.contains('citem') && ev.classList.contains('is-event'));
  assert.match(text(ev), /10:00–11:00.*Dentist.*Rue X/);
  const gym = calItemRow(app, PLANNED, byId);
  assert.ok(gym.classList.contains('is-gym') && gym.classList.contains('is-planned'));
  assert.equal(gym.attrs.href, '#/gym');
  const rit = calItemRow(app, RITUAL, byId);
  assert.ok(rit.classList.contains('is-ritual'));
  assert.match(text(rit), /21:00.*Read/);
});
