// Today screen: one phone screen, every input one tap. Writes are optimistic and never block the UI.
import { h, longPress } from './dom.js';
import { buildTodayModel } from './today-model.js';
import { nextStatus } from '../lib/habits.js';
import { toggleItem } from '../lib/rituals.js';
import { LITER_CHIPS, PAGE_CHIPS, buildSleep, formatDuration, parseLiters } from '../lib/health.js';
import { nowHHMM } from '../lib/dates.js';
import * as repo from '../data/repo.js';

// UI-only state; survives re-renders but not reloads.
const ui = { rituals: new Set(), waterOpen: false, sleepEdit: false, pagesEdit: false, notice: '', focus: null };
let pendingEl = null;

const uid = () => crypto.randomUUID();
const fmtL = (x) => String(Math.round(x * 100) / 100);
const setNotice = (text) => { ui.notice = text; };

function refreshPending(app) {
  if (!pendingEl) return;
  const n = app.ctx?.outbox?.pending?.() ?? 0;
  pendingEl.textContent = n > 0 ? `${n} pending` : '';
  pendingEl.hidden = n === 0;
}

// Optimistic update, repaint, then the repo write. A failed write restores server state and says so calmly.
function commit(app, mutate, write) {
  ui.notice = '';
  mutate(app.snapshot);
  app.rerender();
  let p;
  try { p = Promise.resolve(write()); } catch (e) { p = Promise.reject(e); }
  p.then(() => {}, () => { setNotice('Could not save that. Try again.'); app.refresh(); });
  p.finally(() => { refreshPending(app); setTimeout(() => refreshPending(app), 900); setTimeout(() => refreshPending(app), 4000); });
}

function upsertBy(rows, match, patch, make) {
  const row = rows.find(match);
  if (row) Object.assign(row, patch);
  else rows.push({ ...make, ...patch });
}

// ---- actions ----
function setHabit(app, id, status) {
  const today = app.todayKey;
  commit(app, (s) => {
    s.habitLogs = s.habitLogs.filter((l) => !(l.habit_id === id && l.date === today));
    if (status) s.habitLogs.push({ id: uid(), habit_id: id, date: today, status });
  }, () => repo.setHabitStatus(app.ctx, id, today, status));
}

function addWater(app, liters) {
  ui.waterOpen = false;
  ui.notice = '';
  let row;
  try { row = repo.addWater(app.ctx, liters); } catch { setNotice('Could not save that. Try again.'); app.rerender(); return; }
  app.snapshot.water = [...app.snapshot.water, row];
  app.rerender();
  refreshPending(app);
  setTimeout(() => refreshPending(app), 900);
}

function undoWater(app, id) {
  commit(app, (s) => { s.water = s.water.filter((w) => w.id !== id); }, () => repo.removeWater(app.ctx, id));
}

function confirmSleep(app, bed, wake) {
  let built;
  try { built = buildSleep({ wakeDateKey: app.todayKey, bed, wake }); } catch {
    setNotice('Check the times: sleep must be under 20 hours.');
    app.rerender();
    return;
  }
  ui.sleepEdit = false;
  commit(app, (s) => {
    s.sleep = s.sleep.filter((r) => r.night_of !== built.night_of);
    s.sleep.push({ id: uid(), night_of: built.night_of, bed_at: built.bed_at.toISOString(), wake_at: built.wake_at.toISOString() });
    s.sleep.sort((a, b) => (a.night_of < b.night_of ? -1 : 1));
  }, () => repo.saveSleep(app.ctx, built));
}

function setDaily(app, patch, bookId) {
  const today = app.todayKey;
  const write = bookId ? { ...patch, book_id: bookId } : patch;
  commit(app, (s) => upsertBy(s.daily, (d) => d.date === today, write, { id: uid(), date: today, pages: 0, mood: null, book_id: null }),
    () => repo.setDaily(app.ctx, today, write));
}

function toggleRitual(app, entry, i) {
  const n = entry.ritual.checklist.length;
  const next = toggleItem(entry.state, i, n);
  commit(app, (s) => upsertBy(s.ritualLogs, (l) => l.ritual_id === entry.ritual.id && l.week_start === entry.weekStart,
    { checklist_state: next.state, done_at: next.done ? new Date().toISOString() : null },
    { id: uid(), ritual_id: entry.ritual.id, week_start: entry.weekStart }),
  () => repo.saveRitualLog(app.ctx, entry.ritual.id, entry.weekStart, next.state, next.done));
}

// ---- small pieces ----
const row = (label, value, ...controls) =>
  h('div', { class: 'trow' },
    h('div', { class: 'tlabel' }, h('span', { class: 'cap' }, label), value),
    h('div', { class: 'tctl' }, controls));

const chip = (text, onClick, extra = {}) =>
  h('button', { type: 'button', class: 'tap chip', onClick, ...extra }, text);

function holdTap(el, onTap, onHold) {
  longPress(el, { onTap, onHold });
  // Keyboard / assistive activation arrives as a click with detail 0.
  el.addEventListener('click', (e) => { if (e.detail === 0) onTap(); });
  return el;
}

function nowNextRows(model, now) {
  return model.nowNext.map((e) => {
    const current = e.start_time <= now && (e.end_time ? now < e.end_time : true) && model.nowNext[0] === e;
    return h('div', { class: 'tnow' },
      h('span', { class: 'cap' }, current ? 'Now' : 'Next'),
      h('span', { class: 'num' }, e.start_time),
      h('span', { class: 'ellip' }, e.title));
  });
}

function ritualBlock(app, entry) {
  const id = entry.ritual.id;
  const open = ui.rituals.has(id);
  const n = entry.ritual.checklist.length;
  const count = entry.state.filter(Boolean).length;
  const head = h('button', {
    type: 'button', class: `tap tline${entry.done ? ' is-done' : ''}`, 'aria-expanded': open ? 'true' : 'false',
    onClick: () => { if (open) ui.rituals.delete(id); else ui.rituals.add(id); app.rerender(); },
  },
  h('span', { class: 'ellip grow' }, entry.ritual.name),
  entry.overdue ? h('span', { class: 'muted' }, 'overdue') : null,
  h('span', { class: 'muted num' }, `${count}/${n}`));
  const items = open
    ? h('div', { class: 'tchecks' }, entry.ritual.checklist.map((text, i) =>
      h('button', {
        type: 'button', class: `tap tcheck${entry.state[i] ? ' is-done' : ''}`, role: 'checkbox',
        'aria-checked': entry.state[i] ? 'true' : 'false', onClick: () => toggleRitual(app, entry, i),
      }, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'grow' }, text))))
    : null;
  return h('div', {}, head, items);
}

function habitCell(app, hb) {
  const sub = hb.status === 'done' ? null
    : hb.status === 'skipped' ? 'skipped'
    : hb.flag === 'red' ? 'missed twice'
    : hb.flag === 'warn' ? 'missed yesterday' : null;
  const el = h('button', {
    type: 'button', class: `tap habit${hb.status ? ` is-${hb.status}` : ''}`, 'aria-pressed': hb.status === 'done' ? 'true' : 'false',
    'aria-label': `${hb.name}${hb.status ? `, ${hb.status}` : ''}`,
  },
  h('span', { class: 'ellip hname' }, hb.name),
  h('span', { class: 'hsub' },
    hb.streak > 0 ? h('span', { class: 'num' }, `${hb.streak}d`) : null,
    sub ? h('span', { class: hb.status ? '' : hb.flag === 'red' ? 'danger' : '' }, sub) : null));
  return holdTap(el,
    () => setHabit(app, hb.id, nextStatus(hb.status, 'tap')),
    () => setHabit(app, hb.id, nextStatus(hb.status, 'hold')));
}

function inlineInput({ type = 'text', inputmode, placeholder, label, value, onSubmit, submitText, error }) {
  const input = h('input', {
    class: 'field tfield', type, inputmode, placeholder, 'aria-label': label, value: value ?? '', autocomplete: 'off',
    ...(error ? { 'aria-invalid': 'true' } : {}),
  });
  const go = () => onSubmit(input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  queueMicrotask(() => { try { input.focus({ preventScroll: true }); } catch { /* ignore */ } });
  return [input, h('button', { type: 'button', class: 'tap chip', onClick: go }, submitText)];
}

function waterSection(app, m) {
  const over = m.water.total >= m.water.target;
  const chips = [
    ...LITER_CHIPS.map((l) => chip(`+${fmtL(l)}`, () => addWater(app, l))),
    chip('+…', () => { ui.waterOpen = !ui.waterOpen; app.rerender(); }, { 'aria-expanded': ui.waterOpen ? 'true' : 'false', 'aria-label': 'Other amount' }),
  ];
  const nodes = [row('Water', h('span', { class: `num${over ? ' is-done-text' : ''}` }, `${fmtL(m.water.total)} / ${fmtL(m.water.target)} L`), chips)];
  if (ui.waterOpen) {
    const err = ui.notice.startsWith('Water');
    nodes.push(h('div', { class: 'tinline' }, inlineInput({
      inputmode: 'decimal', placeholder: 'Liters, e.g. 0,33', label: 'Liters', submitText: 'Add', error: err,
      onSubmit: (v) => {
        const l = parseLiters(v);
        if (l === null) { setNotice('Water: enter an amount up to 3 L, like 0,33.'); app.rerender(); return; }
        addWater(app, l);
      },
    })));
    if (err) nodes.push(h('p', { class: 'danger tnotice', role: 'status' }, ui.notice));
  }
  if (m.water.last) {
    nodes.push(h('div', { class: 'tundo' },
      h('button', { type: 'button', class: 'tap link', onClick: () => undoWater(app, m.water.last.id) }, `undo +${fmtL(m.water.last.liters)}`)));
  }
  return nodes;
}

function sleepSection(app, m) {
  const { sleep } = m;
  const value = h('span', { class: 'num' }, sleep.minutes ? formatDuration(sleep.minutes) : '–');
  if (ui.sleepEdit) {
    const bed = h('input', { class: 'field tfield', type: 'time', value: sleep.bed, 'aria-label': 'Bed time' });
    const wake = h('input', { class: 'field tfield', type: 'time', value: sleep.wake, 'aria-label': 'Wake time' });
    return [row('Sleep', value,
      bed, wake,
      chip('Save', () => confirmSleep(app, bed.value || sleep.bed, wake.value || sleep.wake)))];
  }
  const times = h('button', {
    type: 'button', class: 'tap chip times', 'aria-label': 'Edit sleep times',
    onClick: () => { ui.sleepEdit = true; app.rerender(); },
  }, `${sleep.bed} → ${sleep.wake}`);
  return [row('Sleep', value, times,
    sleep.logged ? null : chip('Confirm', () => confirmSleep(app, sleep.bed, sleep.wake), { class: 'tap chip chip-strong' }))];
}

function pagesSection(app, m) {
  const book = m.pages.book;
  const bookId = book?.id ?? null;
  const total = ui.pagesEdit
    ? null
    : h('button', { type: 'button', class: 'tap link num', 'aria-label': 'Correct today’s pages', onClick: () => { ui.pagesEdit = true; app.rerender(); } }, `${m.pages.today} today`);
  const nodes = [row('Pages', total ?? h('span', { class: 'num' }, `${m.pages.today} today`),
    ...PAGE_CHIPS.map((n) => chip(`+${n}`, () => setDaily(app, { pages: m.pages.today + n }, bookId))),
    book ? h('span', { class: 'muted ellip tbook' }, book.title) : null)];
  if (ui.pagesEdit) {
    const err = ui.notice.startsWith('Pages');
    nodes.push(h('div', { class: 'tinline' }, inlineInput({
      inputmode: 'numeric', placeholder: 'Pages today', label: 'Pages today', value: String(m.pages.today), submitText: 'Set', error: err,
      onSubmit: (v) => {
        const t = String(v).trim();
        const n = /^\d{1,4}$/.test(t) ? Number(t) : null;
        if (n === null) { setNotice('Pages: enter a whole number.'); app.rerender(); return; }
        ui.pagesEdit = false;
        setDaily(app, { pages: n }, bookId);
      },
    })));
    if (err) nodes.push(h('p', { class: 'danger tnotice', role: 'status' }, ui.notice));
  }
  return nodes;
}

function moodSection(app, m) {
  const btns = [1, 2, 3, 4, 5].map((n) => h('button', {
    type: 'button', class: `tap chip mood${m.mood === n ? ' is-done' : ''}`, 'aria-pressed': m.mood === n ? 'true' : 'false', 'aria-label': `Mood ${n}`,
    onClick: () => setDaily(app, { mood: m.mood === n ? null : n }),
  }, String(n)));
  return [row('Mood', h('span', { class: 'muted num' }, m.mood ? `${m.mood} / 5` : '–'), btns)];
}

export function renderToday(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Today'), h('p', { class: 'muted' }, 'Loading…'));
    return;
  }
  const now = nowHHMM();
  const m = buildTodayModel(app.snapshot, app.todayKey, now);

  pendingEl = h('span', { class: 'muted tpending', role: 'status', hidden: true });

  const habitsBlock = m.habits.length
    ? h('div', { class: 'habits' }, m.habits.map((hb) => habitCell(app, hb)))
    : h('p', { class: 'muted tempty' }, 'Add your habits in More.');

  const wk = m.week;
  const footer = `This week: pages ${wk.pages}/${wk.pagesTarget} · habits ${wk.habitsPct === null ? '–' : `${wk.habitsPct}%`}`;

  root.replaceChildren(
    h('div', { class: 'today' },
      h('header', { class: 'thead' }, h('h1', {}, m.dayLabel), pendingEl),
      m.nowNext.length ? h('section', { class: 'tsec', 'aria-label': 'Now and next' }, nowNextRows(m, now)) : null,
      m.rituals.length ? h('section', { class: 'tsec', 'aria-label': 'Today’s ritual' }, m.rituals.map((e) => ritualBlock(app, e))) : null,
      h('section', { class: 'tsec', 'aria-label': 'Habits' },
        h('div', { class: 'thint' }, h('span', { class: 'cap' }, 'Habits'), h('span', { class: 'muted' }, 'tap done, hold skip')),
        habitsBlock),
      h('section', { class: 'tsec', 'aria-label': 'Health' },
        waterSection(app, m), sleepSection(app, m), pagesSection(app, m), moodSection(app, m)),
      ui.notice && !/^(Water|Pages):/.test(ui.notice) ? h('p', { class: 'danger tnotice', role: 'status' }, ui.notice) : null,
      h('p', { class: 'muted tfoot' }, footer)),
  );
  refreshPending(app);
}
