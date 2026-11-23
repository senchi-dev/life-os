// Calendar tab: 7-day agenda plus a quick-add form pinned above the tab bar. Writes are optimistic.
import { h } from './dom.js';
import { agenda } from '../lib/agenda.js';
import { validateEvent, splitWindow } from '../lib/event-form.js';
import { formatDayLabel, addDays, isNewDay, localDateKey } from '../lib/dates.js';
import * as repo from '../data/repo.js';

export { validateEvent };

// UI-only state; survives re-renders but not reloads. draft.date null = "today".
const blank = () => ({ id: null, title: '', date: null, start: '', end: '', location: '' });
const ui = { draft: blank(), notice: '', info: false, confirmDelete: false, focusNext: null };

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
function commit(app, mutate, write) {
  mutate(app.snapshot);
  app.rerender();
  let p;
  try { p = Promise.resolve(write()); } catch (e) { p = Promise.reject(e); }
  p.then(() => {}, () => { ui.notice = 'Could not save that. Try again.'; ui.info = false; return app.refresh(); }).catch(() => {});
}

function submit(app) {
  syncToday(app);
  const d = ui.draft;
  const date = d.date ?? app.todayKey;
  const candidate = { title: d.title, date, start_time: d.start, end_time: d.end };
  const err = validateEvent(candidate);
  if (err) { ui.notice = err; ui.info = false; app.rerender(); return; }
  const prev = d.id ? app.snapshot.events.find((e) => e.id === d.id) : null;
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
  ui.notice = '';
  ui.info = false;
  if (date > addDays(app.todayKey, 6)) { ui.notice = `Saved for ${formatDayLabel(date)}, shown under Later`; ui.info = true; }
  else if (date < app.todayKey) { ui.notice = `Saved for ${formatDayLabel(date)}`; ui.info = true; }
  commit(app, (s) => {
    s.events = editing ? s.events.map((e) => (e.id === row.id ? row : e)) : [...s.events, row];
  }, () => repo.saveEvent(app.ctx, row));
}

function remove(app) {
  const id = ui.draft.id;
  if (!id) return;
  if (!ui.confirmDelete) { ui.confirmDelete = true; ui.notice = ''; app.rerender(); return; }
  reset();
  ui.notice = '';
  commit(app, (s) => { s.events = s.events.filter((e) => e.id !== id); }, () => repo.deleteEvent(app.ctx, id));
}

function select(app, e) {
  ui.draft = { id: e.id, title: e.title, date: e.date, start: hhmm(e.start_time), end: hhmm(e.end_time), location: e.location ?? '' };
  ui.confirmDelete = false;
  ui.notice = '';
  app.rerender();
}

function cancel(app) {
  reset();
  ui.notice = '';
  app.rerender();
}

function field(label, key, { todayKey, ...props }) {
  const input = h('input', {
    class: 'field cfield', 'aria-label': label, 'data-draft': key, autocomplete: 'off', ...props,
    value: key === 'date' ? (ui.draft.date ?? todayKey) : ui.draft[key],
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

function agendaItem(app, it, byId) {
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

function form(app) {
  const d = ui.draft;
  const editing = Boolean(d.id);
  const err = ui.notice;
  const titleInput = field('Title', 'title', { type: 'text', placeholder: 'New event', maxlength: '120', enterkeyhint: 'done', ...(err && /^Title/.test(err) ? { 'aria-invalid': 'true' } : {}) });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(app); } });
  const date = field('Date', 'date', { type: 'date', todayKey: app.todayKey });
  const start = field('Start time', 'start', { type: 'time' });
  const end = field('End time', 'end', { type: 'time', ...(err && /^(End|Add a start)/.test(err) ? { 'aria-invalid': 'true' } : {}) });
  const loc = field('Location', 'location', { type: 'text', placeholder: 'Location (optional)', maxlength: '120' });
  return h('form', {
    class: 'cform', novalidate: 'true', 'aria-label': editing ? 'Edit event' : 'Add event',
    onSubmit: (e) => { e.preventDefault(); submit(app); },
  },
  h('div', { class: 'cformhead' },
    h('span', { class: 'cap' }, editing ? 'Edit event' : 'Add event'),
    editing ? h('button', { type: 'button', class: 'tap link clink', onClick: () => cancel(app) }, 'Cancel') : null),
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

export function renderCalendar(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Calendar'), h('p', { class: 'muted' }, 'Loading…'));
    return;
  }
  const active = root.contains(document.activeElement) ? document.activeElement.dataset?.draft : null;
  if (active) ui.focusNext = active;
  syncToday(app);
  const events = app.snapshot.events ?? [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const { later } = splitWindow(events, app.todayKey, 7);
  const laterShown = later.slice(0, 20);
  const days = agenda(events, app.snapshot.rituals ?? [], app.todayKey, 7);

  root.replaceChildren(
    h('div', { class: 'cal' },
      h('h1', {}, 'Calendar'),
      days.map((day, i) => h('section', { class: 'cday', 'aria-label': i === 0 ? 'Today' : formatDayLabel(day.date) },
        h('h2', { class: 'cap cdayhead' }, i === 0 ? 'Today' : formatDayLabel(day.date)),
        day.items.length
          ? day.items.map((it) => agendaItem(app, it, byId))
          : h('p', { class: 'muted cempty' }, 'Nothing planned'))),
      laterShown.length ? h('section', { class: 'cday', 'aria-label': 'Later' },
        h('h2', { class: 'cap cdayhead' }, 'Later'),
        laterShown.map((e) => laterItem(app, e))) : null,
      form(app)),
  );
}
