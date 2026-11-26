// Calendar tab: Agenda / Day / Week / Month switcher, a colour legend, the view, and a quick-add form pinned above
// the tab bar. Writes are optimistic. Events outside the boot window are fetched on demand into `cal.extra`.
import { h } from './dom.js';
import { section, list } from './blocks.js';
import { renderDay, renderWeek, renderMonth, dayScrollTarget } from './cal-views.js';
import { loadingNodes } from './loading.js';
import { agenda } from '../lib/agenda.js';
import { plannedRows } from '../lib/schedule.js';
import { displayMinutes } from '../lib/workout.js';
import { validateEvent, splitWindow } from '../lib/event-form.js';
import { formatDayLabel, addDays, isNewDay, localDateKey, minutesToHHMM } from '../lib/dates.js';
import { CAL_VIEWS, readCalView, writeCalView, rangeFor, step } from '../lib/cal-range.js';
import { itemsByDay } from '../lib/cal-items.js';
import { bootWindow, missingRange, addLoaded, mergeEvents, windowStatus } from '../lib/event-window.js';
import * as repo from '../data/repo.js';

export { validateEvent };

// View state for the session. view: read from storage once (module state wins when storage is blocked).
// loaded: ranges fetched on demand (the boot window is added at each check); extra: their events.
// failedKey/pending: the missing range whose fetch failed / is in flight, so a render never refetches in a loop.
const blankCal = () => ({
  view: null, anchor: null, loaded: [], extra: [], status: 'ok', scrolled: false, scrollTop: null, pending: null, failedKey: null,
});
let cal = blankCal();

const VIEW_LABELS = { agenda: 'Agenda', day: 'Day', week: 'Week', month: 'Month' };
const RENDERERS = { day: renderDay, week: renderWeek, month: renderMonth };
const STATUS_TEXT = { offline: 'Not loaded offline', failed: 'Could not load these dates' };

function calStore() { try { return localStorage; } catch { return null; } }
const isOnline = () => globalThis.navigator?.onLine !== false;

export function resetCalendar() {
  cal = blankCal();
  reset();
  ui.notice = '';
  ui.info = false;
  ui.formOpen = false;
}

// Live module state, for unit tests of the shell logic (no DOM needed).
export function calendarState() { return { cal, ui }; }

// The form's date when the user has not picked one: the shown day in Day and Month views, otherwise none (today).
export function formDate(view, anchor, todayKey) { // todayKey: part of the shared signature, unused today
  return view === 'day' || view === 'month' ? anchor : null;
}

const shownEvents = (app) => mergeEvents(app.snapshot?.events ?? [], cal.extra);

// Fetch the part of `range` not loaded yet (online only). Success: remember the range, keep its events, rerender.
// Failure keeps everything already loaded and shows the failed line until the user navigates.
export function ensureRange(app, range) {
  const loaded = addLoaded(cal.loaded, bootWindow(app.todayKey));
  const miss = missingRange(loaded, range);
  const key = miss ? `${miss.from}..${miss.to}` : null;
  const online = isOnline();
  cal.status = windowStatus({ loaded, want: range, online, failed: key !== null && cal.failedKey === key });
  if (!miss || !online || cal.pending === key || cal.failedKey === key) return cal.status;
  const mine = cal;
  mine.pending = key;
  Promise.resolve()
    .then(() => repo.loadEvents(app.ctx, miss.from, miss.to))
    .then((rows) => {
      const ids = new Set(rows.map((e) => e.id));
      mine.extra = [...mine.extra.filter((e) => !ids.has(e.id)), ...rows];
      mine.loaded = addLoaded(mine.loaded, miss);
    }, () => { mine.failedKey = key; })
    .finally(() => {
      mine.pending = null;
      if (cal === mine) app.rerender();
    })
    .catch(() => {});
  return cal.status;
}

// UI-only state; survives re-renders but not reloads. draft.date null = "today".
const blank = () => ({ id: null, title: '', date: null, start: '', end: '', location: '' });
// formOpen: the add/edit form is collapsed behind an "Add event" button until opened or an event is selected.
const ui = { draft: blank(), notice: '', info: false, confirmDelete: false, focusNext: null, formOpen: false };

const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

function syncToday(app) {
  const now = new Date();
  if (!isNewDay(app.todayKey, now)) return false;
  app.todayKey = localDateKey(now);
  app.refresh();
  return true;
}

function reset() {
  ui.draft = blank();
  ui.confirmDelete = false;
}

// Optimistic update, repaint, then the write. A failed write restores server state and says so calmly.
// The mutate also applies to the on-demand events (`cal.extra`) so edits and deletes of fetched events show at once.
// A failed write undoes only the touched row in `extra`: rows fetched meanwhile stay.
function commit(app, id, mutate, write) {
  const mine = cal;
  const before = mine.extra.find((e) => e.id === id) ?? null;
  mutate(app.snapshot, mine);
  app.rerender();
  let p;
  try { p = Promise.resolve(write()); } catch (e) { p = Promise.reject(e); }
  p.then(() => {}, () => {
    mine.extra = [...mine.extra.filter((e) => e.id !== id), ...(before ? [before] : [])];
    ui.notice = 'Could not save that. Try again.'; ui.info = false; return app.refresh();
  }).catch(() => {});
}

function submit(app) {
  syncToday(app);
  const d = ui.draft;
  const date = d.date ?? formDate(cal.view, cal.anchor, app.todayKey) ?? app.todayKey;
  const candidate = { title: d.title, date, start_time: d.start, end_time: d.end };
  const err = validateEvent(candidate);
  if (err) { ui.notice = err; ui.info = false; app.rerender(); return; }
  const prev = d.id ? shownEvents(app).find((e) => e.id === d.id) : null;
  const row = {
    ...(prev ?? {}),
    id: d.id ?? crypto.randomUUID(),
    title: d.title.trim(),
    date,
    start_time: d.start || null,
    end_time: d.end || null,
    location: d.location.trim() || null,
  };
  const editing = Boolean(d.id);
  reset();
  ui.formOpen = false;
  ui.notice = '';
  ui.info = false;
  if (date > addDays(app.todayKey, 6)) { ui.notice = `Saved for ${formatDayLabel(date)}, shown under Later`; ui.info = true; }
  else if (date < app.todayKey) { ui.notice = `Saved for ${formatDayLabel(date)}`; ui.info = true; }
  commit(app, row.id, (s, c) => {
    s.events = editing && s.events.some((e) => e.id === row.id) ? s.events.map((e) => (e.id === row.id ? row : e)) : [...s.events, row];
    // Outside the boot window a snapshot refresh drops the row, so the fetched list keeps its copy.
    const boot = bootWindow(app.todayKey);
    const inBoot = date >= boot.from && date <= boot.to;
    if (!inBoot || c.extra.some((e) => e.id === row.id)) c.extra = [...c.extra.filter((e) => e.id !== row.id), row];
  }, () => repo.saveEvent(app.ctx, row));
}

function remove(app) {
  const id = ui.draft.id;
  if (!id) return;
  if (!ui.confirmDelete) { ui.confirmDelete = true; ui.notice = ''; app.rerender(); return; }
  reset();
  ui.formOpen = false;
  ui.notice = '';
  commit(app, id, (s, c) => {
    s.events = s.events.filter((e) => e.id !== id);
    c.extra = c.extra.filter((e) => e.id !== id);
  }, () => repo.deleteEvent(app.ctx, id));
}

function select(app, e) {
  ui.draft = { id: e.id, title: e.title, date: e.date, start: hhmm(e.start_time), end: hhmm(e.end_time), location: e.location ?? '' };
  ui.confirmDelete = false;
  ui.notice = '';
  ui.formOpen = true;
  app.rerender();
}

function cancel(app) {
  reset();
  ui.notice = '';
  ui.formOpen = false;
  app.rerender();
}

function openForm(app) {
  ui.formOpen = true;
  ui.notice = '';
  ui.info = false;
  ui.focusNext = 'title';
  app.rerender();
}

export { submit as submitEvent, remove as removeEvent, select as selectEvent, cancel as closeForm, openForm };

function field(label, key, { fallback, ...props }) {
  const input = h('input', {
    class: 'field cfield', 'aria-label': label, 'data-draft': key, autocomplete: 'off', ...props,
    value: key === 'date' ? (ui.draft.date ?? fallback) : ui.draft[key],
  });
  input.addEventListener('input', () => { ui.draft[key] = input.value; });
  if (ui.focusNext === key) {
    ui.focusNext = null;
    queueMicrotask(() => {
      try { input.focus({ preventScroll: true }); const n = input.value.length; if (props.type === 'text') input.setSelectionRange(n, n); } catch { /* ignore */ }
    });
  }
  return input;
}

function labelled(text, control) {
  return h('label', { class: 'clabel' }, h('span', { class: 'muted' }, text), control);
}

// The 7-day agenda with the Gym plan merged in by date (spec 4a): a planned slot is a muted "Upper Force · planned" row,
// a finished workout replaces it ("Upper Force · 58 min", dash when the duration is unknown, A9). Gym rows go last in the day.
export function calendarPlanned(snapshot, todayKey) {
  const s = snapshot ?? {};
  const days = agenda(s.events ?? [], s.rituals ?? [], todayKey, 7);
  const rows = plannedRows({ slots: s.scheduleSlots ?? [], routines: s.routines ?? [], workouts: s.workouts ?? [], todayKey, days: 7 });
  for (const r of rows) {
    const day = days.find((d) => d.date === r.date);
    if (!day) continue;
    day.items.push(r.kind === 'done'
      ? { kind: 'gym', state: 'done', title: r.name, label: `${r.name} · ${displayMinutes(r.minutes)}`, href: `#/gym/history/${encodeURIComponent(r.workoutId)}`, muted: false }
      : { kind: 'gym', state: 'planned', title: r.name, label: `${r.name} · planned`, href: '#/gym', muted: true });
  }
  return days;
}

function gymItem(it) {
  return h('a', { class: `tap citem is-gym${it.muted ? ' is-planned' : ''}`, href: it.href },
    h('span', { class: 'num ctime' }, 'Gym'),
    h('span', { class: 'ellip grow', lang: '' }, it.label));
}

function agendaItem(app, it, byId) {
  if (it.kind === 'gym') return gymItem(it);
  if (it.kind === 'ritual') {
    return h('div', { class: 'citem is-ritual' },
      h('span', { class: 'num ctime' }, hhmm(it.time)),
      h('span', { class: 'ellip grow' }, it.title));
  }
  const e = byId.get(it.id);
  const selected = ui.draft.id === it.id;
  const end = hhmm(e.end_time);
  const time = it.time ? `${hhmm(it.time)}${end ? `–${end}` : ''}` : '';
  return h('button', {
    type: 'button', class: `tap citem is-event${selected ? ' is-selected' : ''}`, 'aria-pressed': selected ? 'true' : 'false',
    onClick: () => select(app, e),
  },
  h('span', { class: 'num ctime' }, time),
  h('span', { class: 'cbody' },
    h('span', { class: 'ellip' }, it.title),
    e.location ? h('span', { class: 'muted ellip' }, e.location) : null));
}

// A calendar item (lib/cal-items) as an Agenda row: the Month view's selected-day list uses the Agenda builder.
export function calItemRow(app, it, byId) {
  const time = it.start == null ? null : minutesToHHMM(it.start);
  if (it.kind === 'gym') return agendaItem(app, { kind: 'gym', label: it.label, href: it.href, muted: it.state === 'planned' }, byId);
  if (it.kind === 'event' && !byId.has(it.id)) return null;
  return agendaItem(app, { kind: it.kind, id: it.id, time, title: it.title }, byId);
}

function laterItem(app, e) {
  const selected = ui.draft.id === e.id;
  const time = e.start_time ? `${hhmm(e.start_time)}${e.end_time ? `\u2013${hhmm(e.end_time)}` : ''}` : '';
  return h('button', {
    type: 'button', class: `tap citem is-event${selected ? ' is-selected' : ''}`, 'aria-pressed': selected ? 'true' : 'false',
    onClick: () => select(app, e),
  },
  h('span', { class: 'num ctime' }, formatDayLabel(e.date)),
  h('span', { class: 'cbody' },
    h('span', { class: 'ellip' }, e.title),
    h('span', { class: 'muted ellip' }, [time, e.location].filter(Boolean).join(' \u00b7 ') || null)));
}

// Collapsed: the last notice (saved / could not save) and an "Add event" button. Open: the add/edit form.
function formArea(app) {
  if (ui.formOpen) return form(app);
  return h('div', { class: 'cal-addarea' },
    ui.notice ? h('p', { class: `cnotice${ui.info ? ' muted' : ' danger'}`, role: 'status' }, ui.notice) : null,
    h('button', { type: 'button', class: 'tap cal-addbtn', onClick: () => openForm(app) }, 'Add event'));
}

function form(app) {
  const d = ui.draft;
  const editing = Boolean(d.id);
  const err = ui.notice;
  const titleInput = field('Title', 'title', { type: 'text', placeholder: 'New event', maxlength: '120', enterkeyhint: 'done', ...(err && /^Title/.test(err) ? { 'aria-invalid': 'true' } : {}) });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(app); } });
  const date = field('Date', 'date', { type: 'date', fallback: formDate(cal.view, cal.anchor, app.todayKey) ?? app.todayKey });
  const start = field('Start time', 'start', { type: 'time' });
  const end = field('End time', 'end', { type: 'time', ...(err && /^(End|Add a start)/.test(err) ? { 'aria-invalid': 'true' } : {}) });
  const loc = field('Location', 'location', { type: 'text', placeholder: 'Location (optional)', maxlength: '120' });
  return h('form', {
    class: 'cform', novalidate: 'true', 'aria-label': editing ? 'Edit event' : 'Add event',
    onSubmit: (e) => { e.preventDefault(); submit(app); },
  },
  h('div', { class: 'cformhead' },
    h('span', { class: 'cap' }, editing ? 'Edit event' : 'Add event'),
    h('button', { type: 'button', class: 'tap link clink', onClick: () => cancel(app) }, 'Cancel')),
  h('div', { class: 'crow1' }, titleInput,
    h('button', { type: 'submit', class: 'tap chip chip-strong cadd' }, editing ? 'Save' : 'Add')),
  h('div', { class: 'crow3' }, labelled('Date', date), labelled('Start', start), labelled('End', end)),
  loc,
  err ? h('p', { class: `cnotice${ui.info ? ' muted' : ' danger'}`, role: 'status' }, err) : null,
  editing
    ? h('button', {
      type: 'button', class: `tap chip cdelete${ui.confirmDelete ? ' is-confirm' : ''}`, onClick: () => remove(app),
    }, ui.confirmDelete ? 'Tap again to delete' : 'Delete')
    : null);
}

function rerenderWith(app, change) {
  change();
  cal.failedKey = null; // a new range gets a fresh fetch attempt
  app.rerender();
}

function setView(app, view) {
  if (cal.view === view) return;
  rerenderWith(app, () => {
    cal.view = view;
    writeCalView(calStore(), view);
    if (view === 'day') cal.scrolled = false;
  });
}

function switcher(app) {
  return h('div', { class: 'seg cal-switch', role: 'group', 'aria-label': 'Calendar view' },
    CAL_VIEWS.map((v) => h('button', {
      type: 'button', class: 'tap', 'aria-pressed': cal.view === v ? 'true' : 'false', onClick: () => setView(app, v),
    }, VIEW_LABELS[v])));
}

function legend() {
  const sw = (kind, text) => [h('span', { class: `cal-sw is-${kind}`, 'aria-hidden': 'true' }), text];
  return h('p', { class: 'cal-legend' }, sw('gym', 'Gym'), ' · ', sw('event', 'Events'), ' · ', sw('ritual', 'Rituals'));
}

function agendaView(app, events, byId) {
  const { later } = splitWindow(events, app.todayKey, 7);
  const laterShown = later.slice(0, 20);
  const days = calendarPlanned({ ...app.snapshot, events }, app.todayKey);
  return [
    days.map((day, i) => section({ title: i === 0 ? 'Today' : formatDayLabel(day.date) },
      day.items.length
        ? list(day.items.map((it) => agendaItem(app, it, byId)))
        : h('p', { class: 'muted cempty' }, 'Nothing planned'))),
    laterShown.length ? section({ title: 'Later' }, list(laterShown.map((e) => laterItem(app, e)))) : null,
  ];
}

function timelineView(app, events, byId) {
  const range = rangeFor(cal.view, cal.anchor, app.todayKey);
  const status = ensureRange(app, range);
  const ctx = {
    anchor: cal.anchor,
    todayKey: app.todayKey,
    byDay: itemsByDay(app.snapshot, range.from, range.to, app.todayKey, events),
    selectedId: ui.draft.id,
    onSelectEvent: (it) => { const e = byId.get(it.id); if (e) select(app, e); },
    onOpenDay: (key) => rerenderWith(app, () => {
      cal.view = 'day'; writeCalView(calStore(), 'day'); cal.anchor = key; cal.scrolled = false;
    }),
    onSelectDay: (key) => rerenderWith(app, () => { cal.anchor = key; }),
    onStep: (dir) => rerenderWith(app, () => { cal.anchor = step(cal.view, cal.anchor, dir); }),
    onToday: () => rerenderWith(app, () => { cal.anchor = app.todayKey; cal.scrolled = false; }),
    agendaRow: (it) => calItemRow(app, it, byId),
  };
  if (cal.view === 'day') {
    if (!cal.scrolled) { cal.scrollTop = dayScrollTarget(ctx); cal.scrolled = true; }
    ctx.scrollTop = cal.scrollTop;
    ctx.onScroll = (px) => { cal.scrollTop = px; };
  }
  return [
    status !== 'ok' ? h('p', { class: 'muted cal-status', role: 'status' }, STATUS_TEXT[status]) : null,
    RENDERERS[cal.view](app, ctx),
  ];
}

export function renderCalendar(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Calendar'), ...loadingNodes(app));
    return;
  }
  const active = root.contains(document.activeElement) ? document.activeElement.dataset?.draft : null;
  if (active) ui.focusNext = active;
  syncToday(app);
  if (cal.view === null) cal.view = readCalView(calStore());
  if (cal.anchor === null) cal.anchor = app.todayKey;
  const events = shownEvents(app);
  const byId = new Map(events.map((e) => [e.id, e]));

  root.replaceChildren(
    h('div', { class: 'cal' },
      h('h1', {}, 'Calendar'),
      switcher(app),
      legend(),
      cal.view === 'agenda' ? agendaView(app, events, byId) : timelineView(app, events, byId),
      formArea(app)),
  );
}
