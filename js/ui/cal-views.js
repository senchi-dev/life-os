// Calendar Day / Week / Month renderers. Pure DOM from ctx; the shell (calendar-view.js) owns state and data.
// ctx = { anchor, todayKey, byDay: Map<dateKey, item[]>, selectedId?, nowMin?, scrollTop?, onScroll?(px),
//         onSelectEvent(item), onOpenDay(key), onSelectDay(key), onStep(dir), onToday(), agendaRow(item) (Month list) }.
// Geometry goes through el.style.setProperty (CSP: no style= attributes).
import { h } from './dom.js';
import { section, list } from './blocks.js';
import { formatDayLabel, minutesToHHMM, parseDateKey } from '../lib/dates.js';
import { GRID_END, gridStart, layoutDay } from '../lib/timeline.js';
import { dayKinds } from '../lib/cal-items.js';
import { weekDays, monthGrid } from '../lib/cal-range.js';

export const HOUR_PX = 48;

// Timed row -> px from the grid top (top/height) and percent of the column (left/width).
export function blockGeometry({ start, end, col, cols }, gridStartMin) {
  return {
    top: ((start - gridStartMin) / 60) * HOUR_PX,
    height: ((end - start) / 60) * HOUR_PX,
    left: (col / cols) * 100,
    width: 100 / cols,
  };
}

const clock = (m) => (m >= GRID_END ? '24:00' : minutesToHHMM(m));
const span = (it) => `${clock(it.start)}–${clock(it.end)}`;
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

// ‹ title › ; the title returns to today.
function navHeader({ title, unit, onStep, onToday }) {
  return h('div', { class: 'cal-nav' },
    h('button', { type: 'button', class: 'tap cal-step', 'aria-label': `Previous ${unit}`, onClick: () => onStep(-1) }, '‹'),
    h('button', { type: 'button', class: 'tap cal-title', 'aria-label': `${title}, go to today`, onClick: () => onToday() }, title),
    h('button', { type: 'button', class: 'tap cal-step', 'aria-label': `Next ${unit}`, onClick: () => onStep(1) }, '›'));
}

// A calendar item as a tappable thing: events select (edit form), gym links to the workout or plan, rituals are plain.
function itemNode(it, ctx, cls, kids, aria) {
  const kind = `${cls} is-${it.kind}${it.state === 'planned' ? ' is-planned' : ''}`;
  if (it.kind === 'event') {
    const selected = ctx.selectedId != null && ctx.selectedId === it.id;
    return h('button', {
      type: 'button', class: `tap ${kind}${selected ? ' is-selected' : ''}`, 'aria-pressed': selected ? 'true' : 'false',
      'aria-label': aria, onClick: () => ctx.onSelectEvent(it),
    }, kids);
  }
  if (it.kind === 'gym' && it.href) return h('a', { class: `tap ${kind}`, href: it.href, 'aria-label': aria }, kids);
  return h('div', { class: kind, 'aria-label': aria }, kids);
}

function allDayStrip(items, ctx) {
  const all = items.filter((i) => i.allDay);
  if (!all.length) return null;
  return h('div', { class: 'cal-allday', 'aria-label': 'All day' },
    all.map((it) => itemNode(it, ctx, 'cal-chip', h('span', { class: 'ellip' }, it.label), null)));
}

export function renderDay(app, ctx) {
  const items = ctx.byDay.get(ctx.anchor) ?? [];
  const gs = gridStart([items]);
  const tl = h('div', { class: 'cal-tl' });
  tl.style.setProperty('height', `${((GRID_END - gs) / 60) * HOUR_PX}px`);
  for (let m = gs; m < GRID_END; m += 60) {
    const line = h('div', { class: 'cal-hour', 'aria-hidden': 'true' }, h('span', { class: 'num cal-hourlabel' }, minutesToHHMM(m)));
    line.style.setProperty('top', `${((m - gs) / 60) * HOUR_PX}px`);
    tl.append(line);
  }
  const cols = h('div', { class: 'cal-cols' });
  for (const row of layoutDay(items)) {
    const g = blockGeometry(row, gs);
    const it = row.item;
    const block = itemNode(it, ctx, 'cal-block', [
      h('span', { class: 'num cal-btime' }, minutesToHHMM(it.start)),
      h('span', { class: 'ellip cal-btitle' }, it.label),
    ], `${it.label}, ${span({ start: row.start, end: row.end })}`);
    block.style.setProperty('top', `${g.top}px`);
    block.style.setProperty('height', `${g.height}px`);
    block.style.setProperty('left', `${g.left}%`);
    block.style.setProperty('width', `${g.width}%`);
    cols.append(block);
  }
  tl.append(cols);
  if (ctx.anchor === ctx.todayKey) {
    const now = Math.min(GRID_END, Math.max(gs, ctx.nowMin ?? nowMinutes()));
    const line = h('div', { class: 'cal-now', 'aria-hidden': 'true' });
    line.style.setProperty('top', `${((now - gs) / 60) * HOUR_PX}px`);
    tl.append(line);
  }
  const scroller = h('div', { class: 'cal-scroll' }, tl);
  if (typeof ctx.onScroll === 'function') scroller.addEventListener('scroll', () => ctx.onScroll(scroller.scrollTop));
  if (Number.isFinite(ctx.scrollTop)) {
    const top = ctx.scrollTop;
    queueMicrotask(() => { scroller.scrollTop = top; }); // after the shell mounts the view
  }
  const title = ctx.anchor === ctx.todayKey ? 'Today' : formatDayLabel(ctx.anchor);
  return h('div', { class: 'cal-view cal-day' },
    navHeader({ title, unit: 'day', onStep: ctx.onStep, onToday: ctx.onToday }),
    allDayStrip(items, ctx),
    scroller);
}

// Scroll offset that puts the current hour (today) or the grid start at the top of the Day timeline.
export function dayScrollTarget(ctx) {
  if (ctx.anchor !== ctx.todayKey) return 0;
  const gs = gridStart([ctx.byDay.get(ctx.anchor) ?? []]);
  const hour = Math.floor((ctx.nowMin ?? nowMinutes()) / 60) * 60;
  return Math.max(0, ((hour - gs) / 60) * HOUR_PX);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KIND_WORDS = { gym: 'gym', event: 'events', ritual: 'rituals' };
const plural = (n) => `${n} item${n === 1 ? '' : 's'}`;
const dayNumber = (key) => String(Number(key.slice(8)));

// Week: 7 Monday-first columns sharing one grid start. Each column is a single button (opens Day view); inside it
// the all-day labels and the timed items as plain coloured bars, with the start time shown only when the column
// is wide enough (container query in calendar.css). The all-day area has the same height in every column so the
// timelines line up.
export function renderWeek(app, ctx) {
  const keys = weekDays(ctx.anchor);
  const lists = keys.map((k) => ctx.byDay.get(k) ?? []);
  const gs = gridStart(lists);
  const tlHeight = `${((GRID_END - gs) / 60) * HOUR_PX}px`;
  const alldayRows = Math.max(0, ...lists.map((l) => l.filter((i) => i.allDay).length));

  const gutter = h('div', { class: 'cal-wtl cal-wgutter', 'aria-hidden': 'true' });
  gutter.style.setProperty('height', tlHeight);
  for (let m = gs; m < GRID_END; m += 60) {
    const label = h('span', { class: 'num cal-hourlabel' }, minutesToHHMM(m));
    label.style.setProperty('top', `${((m - gs) / 60) * HOUR_PX}px`);
    gutter.append(label);
  }

  const cols = keys.map((k, i) => {
    const items = lists[i];
    const tl = h('div', { class: 'cal-wtl' });
    tl.style.setProperty('height', tlHeight);
    for (const row of layoutDay(items)) {
      const g = blockGeometry(row, gs);
      const block = h('span', { class: `cal-wblock is-${row.item.kind}` }, h('span', { class: 'num cal-btime' }, minutesToHHMM(row.start)));
      block.style.setProperty('top', `${g.top}px`);
      block.style.setProperty('height', `${g.height}px`);
      block.style.setProperty('left', `${g.left}%`);
      block.style.setProperty('width', `${g.width}%`);
      tl.append(block);
    }
    const today = k === ctx.todayKey;
    return h('button', {
      type: 'button', class: `tap cal-wcol${today ? ' is-today' : ''}`, 'data-date': k,
      'aria-label': `${formatDayLabel(k)}${today ? ', today' : ''}, ${plural(items.length)}`, onClick: () => ctx.onOpenDay(k),
    },
    h('span', { class: 'cal-whead' }, h('span', { class: 'cal-wname' }, WEEKDAYS[i]), h('span', { class: 'num cal-wnum' }, dayNumber(k))),
    h('span', { class: 'cal-wallday' },
      items.filter((it) => it.allDay).map((it) => h('span', { class: `ellip cal-wchip is-${it.kind}${it.state === 'planned' ? ' is-planned' : ''}` }, it.label))),
    tl);
  });

  const body = h('div', { class: 'cal-wbody' },
    h('div', { class: 'cal-wside' }, h('span', { class: 'cal-whead' }), h('span', { class: 'cal-wallday' }), gutter),
    cols);
  body.style.setProperty('--wk-allday', String(alldayRows));
  const title = `${formatDayLabel(keys[0])} – ${formatDayLabel(keys[6])}`;
  return h('div', { class: 'cal-view cal-week' },
    navHeader({ title, unit: 'week', onStep: ctx.onStep, onToday: ctx.onToday }),
    body);
}

// Month: Monday-first grid, one dot per kind present (KINDS order), today and the selected day (the anchor) marked.
// Tapping a day selects it; its items show below the grid as Agenda rows (ctx.agendaRow, the Agenda's row builder).
export function renderMonth(app, ctx) {
  const { month, weeks } = monthGrid(ctx.anchor);
  const title = parseDateKey(`${month}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const cell = ({ date, inMonth }) => {
    const kinds = dayKinds(ctx.byDay.get(date) ?? []);
    const selected = date === ctx.anchor;
    const cls = `tap cal-mday${inMonth ? '' : ' is-out'}${date === ctx.todayKey ? ' is-today' : ''}${selected ? ' is-selected' : ''}`;
    const what = kinds.length ? kinds.map((k) => KIND_WORDS[k]).join(', ') : 'nothing planned';
    return h('button', {
      type: 'button', class: cls, 'data-date': date, 'aria-pressed': selected ? 'true' : 'false',
      'aria-label': `${formatDayLabel(date)}${date === ctx.todayKey ? ', today' : ''}: ${what}`, onClick: () => ctx.onSelectDay(date),
    },
    h('span', { class: 'num cal-mnum' }, dayNumber(date)),
    h('span', { class: 'cal-mdots', 'aria-hidden': 'true' }, kinds.map((k) => h('span', { class: `cal-dot is-${k}` }))));
  };
  const items = ctx.byDay.get(ctx.anchor) ?? [];
  return h('div', { class: 'cal-view cal-month' },
    navHeader({ title, unit: 'month', onStep: ctx.onStep, onToday: ctx.onToday }),
    h('div', { class: 'cal-mhead', 'aria-hidden': 'true' }, WEEKDAYS.map((d) => h('span', {}, d.slice(0, 1)))),
    h('div', { class: 'cal-mgrid' }, weeks.map((w) => h('div', { class: 'cal-mweek' }, w.map(cell)))),
    h('div', { class: 'cal-mlist' },
      section({ title: ctx.anchor === ctx.todayKey ? 'Today' : formatDayLabel(ctx.anchor) },
        items.length ? list(items.map((it) => ctx.agendaRow(it))) : h('p', { class: 'muted cempty' }, 'Nothing planned'))));
}
