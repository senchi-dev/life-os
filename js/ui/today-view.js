// Today screen: the day score ring, three tiles, the Start bar, then habits and the rest of the day.
// Writes are optimistic and never block the UI. Handlers live in todayActions(app), a DOM-free factory that reads
// app.todayKey, the snapshot and the clock at action time (never from a render-time closure).
import { h, longPress } from './dom.js';
import { loadingNodes } from './loading.js';
import { buildTodayModel } from './today-model.js';
import { ring, tile, sheet } from './components.js';
import { nextStatus } from '../lib/habits.js';
import { ritualState, toggleItem } from '../lib/rituals.js';
import { LITER_CHIPS, PAGE_CHIPS, buildSleep, formatDuration, parseLiters } from '../lib/health.js';
import { nowHHMM, isNewDay, localDateKey } from '../lib/dates.js';
import { formatClock } from '../lib/workout.js';
import { guardedStart } from './start-guard.js';
import * as repoDefault from '../data/repo.js';

const SLEEP_GOAL_MIN = 480;
const FAIL = 'Could not save. Try again.';
const START_FAIL = 'Could not start the workout. Try again.';

// UI-only state; survives re-renders but not reloads. noticeWhere: 'top' (under the tiles) or 'today' (TODAY list).
const ui = {
  rituals: new Set(), waterOpen: false, waterCustom: false, sleepOpen: false, sleepEdit: false, pagesEdit: false,
  notice: '', noticeWhere: 'top', focusNext: null, draft: { water: null, pages: null }, starting: false, ringDay: null,
};
let midnightTimer = null;
let clockTimer = null;
let savedTimer = null;
let openSheet = null;

const uid = () => crypto.randomUUID();
const fmtL = (x) => String(Math.round(x * 100) / 100);

export const weekLineText = (wk) =>
  `This week: pages ${wk.pages}/${wk.pagesTarget} · habits ${wk.habitsPct === null ? '–' : `${wk.habitsPct}%`}`;

// Elapsed workout time as HH:MM:SS; a bad start time or a clock that ran backwards reads 00:00:00.
export function clockText(startedAtIso, nowMs) {
  return formatClock(nowMs - Date.parse(startedAtIso));
}

function upsertBy(rows, match, patch, make) {
  const row = rows.find(match);
  if (row) Object.assign(row, patch);
  else rows.push({ ...make, ...patch });
}

export function todayActions(app, deps = {}) {
  const repo = deps.repo ?? repoDefault;
  const clock = deps.now ?? (() => new Date());
  const navigate = deps.navigate ?? ((hash) => { location.hash = hash; });
  const state = deps.ui ?? ui;

  const notify = (text, where = 'top') => { state.notice = text; state.noticeWhere = where; };
  const flashSaved = (where) => {
    notify('Saved.', where);
    app.rerender();
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { if (state.notice === 'Saved.') { notify(''); app.rerender(); } }, 2500);
    savedTimer.unref?.();
  };

  // The app may stay open past local midnight: move to the new day before reading or writing anything.
  function sync() {
    const now = clock();
    if (!isNewDay(app.todayKey, now)) return false;
    app.todayKey = localDateKey(now);
    Promise.resolve(app.refresh?.()).catch(() => {});
    return true;
  }

  // Optimistic update, repaint, then the repo write. A rejected write puts the touched tables back and says so.
  function commit(keys, mutate, write, { confirm = false, where = 'top' } = {}) {
    notify('');
    const snap = app.snapshot;
    const before = structuredClone(Object.fromEntries(keys.map((k) => [k, snap[k]])));
    mutate(snap);
    app.rerender();
    let p;
    try { p = Promise.resolve(write()); } catch (e) { p = Promise.reject(e); }
    return p.then(
      () => { if (confirm) flashSaved(where); },
      () => {
        if (app.snapshot === snap) Object.assign(snap, before); // a refresh may already have replaced it with server truth
        notify(FAIL, where);
        app.rerender();
      },
    );
  }

  function setHabit(id, status) {
    sync();
    const today = app.todayKey;
    return commit(['habitLogs'], (s) => {
      s.habitLogs = s.habitLogs.filter((l) => !(l.habit_id === id && l.date === today));
      if (status) s.habitLogs.push({ id: uid(), habit_id: id, date: today, status });
    }, () => repo.setHabitStatus(app.ctx, id, today, status));
  }

  function addWater(liters) {
    if (typeof liters !== 'number' || !Number.isFinite(liters) || liters <= 0 || liters > 3) return undefined;
    sync();
    state.waterCustom = false;
    state.draft.water = null;
    notify('');
    const snap = app.snapshot;
    let res;
    try { res = repo.addWater(app.ctx, liters, clock()); } catch { notify(FAIL); app.rerender(); return undefined; }
    snap.water = [...snap.water, res.row];
    app.rerender();
    return Promise.resolve(res.saved).then(
      () => flashSaved('top'),
      () => {
        if (app.snapshot === snap) snap.water = snap.water.filter((w) => w.id !== res.row.id);
        notify(FAIL);
        app.rerender();
      },
    );
  }

  function undoWater(id) {
    sync();
    return commit(['water'], (s) => { s.water = s.water.filter((w) => w.id !== id); }, () => repo.removeWater(app.ctx, id));
  }

  function confirmSleep(bed, wake) {
    sync();
    let built;
    try { built = buildSleep({ wakeDateKey: app.todayKey, bed, wake }); } catch {
      notify('Check the times: sleep must be under 20 hours.');
      app.rerender();
      return undefined;
    }
    state.sleepEdit = false;
    state.sleepOpen = false;
    return commit(['sleep'], (s) => {
      s.sleep = s.sleep.filter((r) => r.night_of !== built.night_of);
      s.sleep.push({ id: uid(), night_of: built.night_of, bed_at: built.bed_at.toISOString(), wake_at: built.wake_at.toISOString() });
      s.sleep.sort((a, b) => (a.night_of < b.night_of ? -1 : 1));
    }, () => repo.saveSleep(app.ctx, built));
  }

  const todayRow = () => (app.snapshot.daily ?? []).find((d) => d.date === app.todayKey) ?? null;

  function setDaily(patch, bookId, opts) {
    sync();
    const today = app.todayKey;
    const write = bookId ? { ...patch, book_id: bookId } : patch;
    return commit(['daily'], (s) => upsertBy(s.daily, (d) => d.date === today, write, { id: uid(), date: today, pages: 0, mood: null, book_id: null }),
      () => repo.setDaily(app.ctx, today, write), opts);
  }

  // Pages: the running total is read when the tap happens, not when the screen was drawn.
  function addPages(n, bookId) {
    sync();
    return setDaily({ pages: Math.min(9999, (todayRow()?.pages ?? 0) + n) }, bookId, { confirm: true, where: 'today' });
  }
  const setPages = (n, bookId) => setDaily({ pages: n }, bookId, { confirm: true, where: 'today' });
  function toggleMood(n) {
    sync();
    return setDaily({ mood: todayRow()?.mood === n ? null : n }, null, { where: 'today' });
  }

  function toggleRitual(entry, i) {
    sync();
    const { ritual, weekStart: ws } = entry;
    const log = (app.snapshot.ritualLogs ?? []).find((l) => l.ritual_id === ritual.id && l.week_start === ws);
    const next = toggleItem(ritualState(ritual, log), i, ritual.checklist);
    return commit(['ritualLogs'], (s) => upsertBy(s.ritualLogs, (l) => l.ritual_id === ritual.id && l.week_start === ws,
      { checklist_state: next.state, done_at: next.done ? new Date().toISOString() : null },
      { id: uid(), ritual_id: ritual.id, week_start: ws }),
    () => repo.saveRitualLog(app.ctx, ritual.id, ws, next.state, next.done));
  }

  // Start (or resume) goes through the gym runtime; only a real draft takes the user to the workout screen.
  async function startWorkout(routineId) {
    if (state.starting) return;
    state.starting = true;
    try {
      const d = await app.gym.start(routineId ?? null);
      if (d) { navigate('#/workout'); return true; }
      notify(START_FAIL); app.rerender();
      return false;
    } catch {
      notify(START_FAIL);
      app.rerender();
      return false;
    } finally {
      state.starting = false;
    }
  }

  const weekLine = (now = clock()) => weekLineText(buildTodayModel(app.snapshot, app.todayKey, nowHHMM(now)).week);

  return {
    ui: state, sync, notify, setHabit, addWater, undoWater, confirmSleep, addPages, setPages, toggleMood, toggleRitual, startWorkout, weekLine,
  };
}

function scheduleMidnight(app, act) {
  clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 500);
  midnightTimer = setTimeout(() => { if (!act.sync()) app.rerender?.(); }, Math.max(1000, next - now));
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

function ritualBlock(app, act, entry) {
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
        'aria-checked': entry.state[i] ? 'true' : 'false', onClick: () => act.toggleRitual(entry, i),
      }, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'grow' }, text))))
    : null;
  return h('div', {}, head, items);
}

function habitRow(act, hb) {
  const flagText = hb.status ? null : hb.flag === 'red' ? 'missed twice' : hb.flag === 'warn' ? 'missed yesterday' : null;
  const statusText = hb.status === 'done' ? 'done' : hb.status === 'skipped' ? 'skipped' : null;
  const streakText = hb.streak > 0 ? (hb.status === 'done' ? `streak ${hb.streak}` : `${hb.streak}d`) : null;
  const sub = [statusText, streakText].filter(Boolean).join(' · ');
  const mark = hb.status === 'done' ? '✓' : hb.status === 'skipped' ? '–' : '';
  const el = h('button', {
    type: 'button', class: `tap habit${hb.status ? ` is-${hb.status}` : ''}`, 'aria-label': hb.ariaLabel,
  },
  h('span', { class: 'hbody' },
    h('span', { class: 'ellip hname' }, hb.text),
    sub || flagText
      ? h('span', { class: 'hsub' },
        sub ? h('span', { class: 'num' }, sub) : null,
        flagText ? h('span', { class: hb.flag === 'red' ? 'danger' : '' }, flagText) : null)
      : null),
  h('span', { class: `hmark${hb.status ? ` is-${hb.status}` : ''}`, 'aria-hidden': 'true' }, mark));
  return holdTap(el,
    () => act.setHabit(hb.id, nextStatus(hb.status, 'tap')),
    () => act.setHabit(hb.id, nextStatus(hb.status, 'hold')));
}

function inlineInput({ type = 'text', inputmode, placeholder, label, value, draftKey, onSubmit, submitText, error }) {
  const input = h('input', {
    class: 'field tfield', type, inputmode, placeholder, 'aria-label': label, value: ui.draft[draftKey] ?? value ?? '', autocomplete: 'off', 'data-draft': draftKey,
    ...(error ? { 'aria-invalid': 'true' } : {}),
  });
  const go = () => onSubmit(input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  input.addEventListener('input', () => { ui.draft[draftKey] = input.value; });
  if (ui.focusNext === draftKey) {
    ui.focusNext = null;
    queueMicrotask(() => {
      try { input.focus({ preventScroll: true }); const n = input.value.length; input.setSelectionRange(n, n); } catch { /* ignore */ }
    });
  }
  return [input, h('button', { type: 'button', class: 'tap chip', onClick: go }, submitText)];
}

// The water tile expands to these chips (and an "other amount" field) in place.
function waterPanel(app, act, m) {
  const chips = [
    ...LITER_CHIPS.map((l) => chip(`+${fmtL(l)}`, () => act.addWater(l))),
    chip('+…', () => { ui.waterCustom = !ui.waterCustom; ui.notice = ''; ui.draft.water = null; ui.focusNext = ui.waterCustom ? 'water' : null; app.rerender(); },
      { 'aria-expanded': ui.waterCustom ? 'true' : 'false', 'aria-label': 'Other amount' }),
  ];
  const nodes = [h('div', { class: 'tctl tchips' }, chips)];
  if (ui.waterCustom) {
    const err = ui.notice.startsWith('Water');
    nodes.push(h('div', { class: 'tinline' }, inlineInput({
      draftKey: 'water', inputmode: 'decimal', placeholder: 'Liters, e.g. 0,33', label: 'Liters', submitText: 'Add', error: err,
      onSubmit: (v) => {
        const l = parseLiters(v);
        if (l === null) { act.notify('Water: enter an amount up to 3 L, like 0,33.'); app.rerender(); return; }
        act.addWater(l);
      },
    })));
    if (err) nodes.push(h('p', { class: 'danger tnotice', role: 'status' }, ui.notice));
  }
  if (m.water.last) {
    nodes.push(h('div', { class: 'tundo' },
      h('button', { type: 'button', class: 'tap link', onClick: () => act.undoWater(m.water.last.id) }, `undo +${fmtL(m.water.last.liters)}`)));
  }
  return h('section', { class: 'tpanel', 'aria-label': 'Add water' }, nodes);
}

// The sleep tile opens the existing confirm / edit block.
function sleepPanel(app, act, m) {
  const { sleep } = m;
  const value = h('span', { class: 'num' }, sleep.minutes ? formatDuration(sleep.minutes) : '–');
  if (ui.sleepEdit) {
    const bed = h('input', { class: 'field tfield', type: 'time', value: sleep.bed, 'aria-label': 'Bed time' });
    const wake = h('input', { class: 'field tfield', type: 'time', value: sleep.wake, 'aria-label': 'Wake time' });
    return h('section', { class: 'tpanel', 'aria-label': 'Sleep' },
      row('Sleep', value, bed, wake, chip('Save', () => act.confirmSleep(bed.value || sleep.bed, wake.value || sleep.wake))));
  }
  const times = h('button', {
    type: 'button', class: 'tap chip times', 'aria-label': 'Edit sleep times',
    onClick: () => { ui.sleepEdit = true; app.rerender(); },
  }, `${sleep.bed} → ${sleep.wake}`);
  return h('section', { class: 'tpanel', 'aria-label': 'Sleep' },
    row('Sleep', value, times,
      sleep.logged ? null : chip('Confirm', () => act.confirmSleep(sleep.bed, sleep.wake), { class: 'tap chip chip-strong' })));
}

function pagesSection(app, act, m) {
  const book = m.pages.book;
  const bookId = book?.id ?? null;
  const total = ui.pagesEdit
    ? h('span', { class: 'num' }, `${m.pages.today} today`)
    : h('button', { type: 'button', class: 'tap link num', 'aria-label': 'Correct today’s pages', onClick: () => { ui.pagesEdit = true; ui.notice = ''; ui.draft.pages = null; ui.focusNext = 'pages'; app.rerender(); } }, `${m.pages.today} today`);
  const nodes = [row('Pages', total,
    ...PAGE_CHIPS.map((n) => chip(`+${n}`, () => act.addPages(n, bookId))),
    book ? h('span', { class: 'muted ellip tbook' }, book.title) : null)];
  if (ui.pagesEdit) {
    const err = ui.notice.startsWith('Pages');
    nodes.push(h('div', { class: 'tinline' }, inlineInput({
      draftKey: 'pages', inputmode: 'numeric', placeholder: 'Pages today', label: 'Pages today', value: String(m.pages.today), submitText: 'Set', error: err,
      onSubmit: (v) => {
        const t = String(v).trim();
        const n = /^\d{1,4}$/.test(t) ? Number(t) : null;
        if (n === null) { act.notify('Pages: enter a whole number.', 'today'); app.rerender(); return; }
        ui.pagesEdit = false;
        ui.draft.pages = null;
        act.setPages(n, bookId);
      },
    })));
    if (err) nodes.push(h('p', { class: 'danger tnotice', role: 'status' }, ui.notice));
  }
  return nodes;
}

function moodSection(act, m) {
  const btns = [1, 2, 3, 4, 5].map((n) => h('button', {
    type: 'button', class: `tap chip mood${m.mood === n ? ' is-done' : ''}`, 'aria-pressed': m.mood === n ? 'true' : 'false', 'aria-label': `Mood ${n}`,
    onClick: () => act.toggleMood(n),
  }, String(n)));
  return [row('Mood', h('span', { class: 'muted num' }, m.mood ? `${m.mood} / 5` : '–'), btns)];
}

// A status line. Errors are danger text; "Saved." is muted. Inline field errors (Water:/Pages:) render in their field.
function noticeLine(where) {
  if (!ui.notice || ui.noticeWhere !== where || /^(Water|Pages):/.test(ui.notice)) return null;
  return h('p', { class: `tnotice${ui.notice === 'Saved.' ? ' muted' : ' danger'}`, role: 'status' }, ui.notice);
}

function closePicker() {
  if (openSheet) { const s = openSheet; openSheet = null; s.close(); }
}

function openPicker(app, act, card) {
  closePicker();
  const body = h('div', { class: 'sheet-list' }, card.others.map((r) =>
    h('button', { type: 'button', class: 'tap sheetrow', onClick: () => { closePicker(); act.startWorkout(r.id); } }, r.name)));
  openSheet = sheet({ title: 'Start a different routine', body, onClose: () => { openSheet = null; } });
  addEventListener('hashchange', closePicker, { once: true });
}

// The Start bar docks above the tab bar (thumb zone): start / resume (live clock) / done.
function startDock(app, act, card, clockNode) {
  let bar;
  if (card.state === 'resume') {
    bar = h('a', { class: 'startbar is-live', href: '#/workout', 'aria-label': `Resume ${card.name ?? 'workout'}` },
      h('span', { class: 'startmain' },
        h('span', { class: 'ellip' }, `Resume${card.name ? ` · ${card.name}` : ''} · `),
        h('span', { class: 'num', role: 'timer' }, clockNode)));
  } else if (card.state === 'done') {
    const bits = ['Done', card.duration && card.duration !== '—' ? card.duration : null, card.sets != null ? `${card.sets} sets` : null].filter(Boolean);
    bar = h('a', { class: 'startbar is-done', href: `#/gym/history/${card.workoutId}` },
      h('span', { class: 'startmain' }, h('span', { class: 'ellip' }, bits.join(' · '))));
  } else {
    bar = h('div', { class: 'startbar' },
      h('button', { type: 'button', class: 'tap startmain', onClick: (e) => { guardedStart(e.currentTarget, () => act.startWorkout(card.routineId)); } },
        h('span', { class: 'ellip' }, `Start workout${card.name ? ` · ${card.name}` : ''}`)),
      card.others.length
        ? h('button', { type: 'button', class: 'tap startchev', 'aria-label': 'Choose another routine', 'aria-haspopup': 'dialog', onClick: () => openPicker(app, act, card) }, '›')
        : null);
  }
  return h('div', { class: 'startdock' }, bar, card.hint ? h('p', { class: 'muted thintline' }, card.hint) : null);
}

export function renderToday(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Today'), ...loadingNodes(app));
    return undefined;
  }
  const act = todayActions(app);
  const active = root.contains(document.activeElement) ? document.activeElement.dataset?.draft : null;
  if (active) ui.focusNext = active;
  act.sync();
  scheduleMidnight(app, act);
  const now = nowHHMM();
  const m = buildTodayModel(app.snapshot, app.todayKey, now, { draft: app.gym?.draft?.() ?? null, index: app.gym?.index?.() ?? null });
  const { score, parts } = m.dayScore;

  clearInterval(clockTimer);
  clockTimer = null;
  let clockNode = null;
  if (m.gymCard.state === 'resume') {
    const started = m.gymCard.startedAt;
    clockNode = document.createTextNode(clockText(started, Date.now()));
    clockTimer = setInterval(() => { clockNode.data = clockText(started, Date.now()); }, 1000); // one text node, once a second
  }

  const animate = ui.ringDay !== app.todayKey;
  ui.ringDay = app.todayKey;

  const tiles = h('div', { class: 'tiles' },
    tile({
      label: 'HABITS', value: parts.H ? `${parts.H.done}/${parts.H.counted}` : '–', bar: parts.H ? parts.H.done / parts.H.counted : 0,
      ariaLabel: parts.H ? `Habits, ${parts.H.done} of ${parts.H.counted} done, show list` : 'Habits, none due today, show list',
      onClick: () => { const el = document.getElementById('today-habits'); el?.scrollIntoView?.({ block: 'start' }); el?.focus?.({ preventScroll: true }); },
    }),
    tile({
      label: 'WATER', value: fmtL(m.water.total), unit: 'L', bar: m.water.total / m.water.target, expanded: ui.waterOpen,
      ariaLabel: `Water, ${fmtL(m.water.total)} of ${fmtL(m.water.target)} liters, add water`,
      onClick: () => { ui.waterOpen = !ui.waterOpen; ui.waterCustom = false; ui.sleepOpen = false; ui.sleepEdit = false; ui.notice = ''; app.rerender(); },
    }),
    tile({
      label: 'SLEEP', value: m.sleep.logged ? formatDuration(m.sleep.minutes) : 'Log', bar: m.sleep.logged ? m.sleep.minutes / SLEEP_GOAL_MIN : 0, expanded: ui.sleepOpen,
      ariaLabel: m.sleep.logged ? `Sleep, ${formatDuration(m.sleep.minutes)}, edit` : 'Sleep, not logged, log sleep',
      onClick: () => { ui.sleepOpen = !ui.sleepOpen; ui.sleepEdit = false; ui.waterOpen = false; ui.waterCustom = false; ui.notice = ''; app.rerender(); },
    }));

  const habitsBlock = m.habits.length
    ? h('div', { class: 'habits' }, m.habits.map((hb) => habitRow(act, hb)))
    : h('p', { class: 'muted tempty' }, 'Add your habits in More.');

  const todayItems = [
    m.nowNext.length ? h('div', { class: 'tgroup', 'aria-label': 'Now and next', role: 'group' }, nowNextRows(m, now)) : null,
    m.rituals.length ? h('div', { class: 'tgroup', 'aria-label': 'Today’s ritual', role: 'group' }, m.rituals.map((e) => ritualBlock(app, act, e))) : null,
    h('div', { class: 'tgroup', role: 'group', 'aria-label': 'Pages and mood' }, pagesSection(app, act, m), moodSection(act, m)),
    noticeLine('today'),
  ];

  root.replaceChildren(
    h('div', { class: 'today' },
      h('header', { class: 'thead' }, h('h1', {}, m.dayLabel)),
      h('section', { class: 'tring', 'aria-label': 'Day score' },
        ring({ value0to1: score / 100, label: 'DAY SCORE', ariaLabel: `Day score ${score} of 100`, good: m.dayScore.good, animate })),
      tiles,
      ui.waterOpen ? waterPanel(app, act, m) : null,
      ui.sleepOpen ? sleepPanel(app, act, m) : null,
      noticeLine('top'),
      h('section', { class: 'tsec', id: 'today-habits', tabindex: '-1', 'aria-label': 'Habits' },
        h('div', { class: 'thint' }, h('span', { class: 'cap' }, 'Habits'), h('span', { class: 'muted' }, 'tap done, hold skip')),
        habitsBlock),
      h('section', { class: 'tsec', 'aria-label': 'Today' },
        h('div', { class: 'thint' }, h('span', { class: 'cap' }, 'Today')),
        todayItems),
      h('p', { class: 'muted tfoot' }, weekLineText(m.week)),
      startDock(app, act, m.gymCard, clockNode)),
  );

  return () => {
    clearTimeout(midnightTimer);
    clearInterval(clockTimer);
    clearTimeout(savedTimer);
    midnightTimer = null;
    clockTimer = null;
    savedTimer = null;
  };
}
