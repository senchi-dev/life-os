// Review tab: one calm screen of numbers for a week, then three prompts. No charts.
import { h } from './dom.js';
import { loadingNodes } from './loading.js';
import { reviewWeekStart, weeklyReview, oldestReviewWeek } from '../lib/review.js';
import { formatDuration } from '../lib/health.js';
import { addDays, formatDayLabel, isNewDay, localDateKey } from '../lib/dates.js';
import * as repo from '../data/repo.js';

const SAVE_DELAY_MS = 600;
const FIELDS = [
  ['went_right', 'Went right'],
  ['went_wrong', 'Went wrong'],
  ['one_change', 'One change for next week'],
];

// UI-only state; survives re-renders but not reloads. drafts: weekStart -> field -> unsaved text.
const ui = { week: null, drafts: {}, notice: '', app: null, timer: null };

const dash = '–';
const fmtPct = (x) => (x == null ? dash : `${Math.round(x * 100)}%`);
const reviewFor = (app, week) => app.snapshot?.reviews?.find((r) => r.week_start === week) ?? null;

// The app may stay open past local midnight: move to the new day before reading anything.
function syncToday(app) {
  const now = new Date();
  if (!isNewDay(app.todayKey, now)) return false;
  app.todayKey = localDateKey(now);
  app.refresh();
  return true;
}

// Weeks we can show: the current review week at most, and nothing whose Monday predates the loaded logs.
const maxWeek = (app) => reviewWeekStart(app.todayKey);
const minWeek = (app) => oldestReviewWeek(app.todayKey);
function shownWeek(app) {
  const max = maxWeek(app), min = minWeek(app);
  let w = ui.week ?? max;
  if (w > max) w = max;
  if (w < min) w = min;
  return w;
}

function upsertReview(app, week, patch) {
  const rows = app.snapshot.reviews;
  const row = rows.find((r) => r.week_start === week);
  if (row) Object.assign(row, patch);
  else rows.push({ id: crypto.randomUUID(), week_start: week, went_right: null, went_wrong: null, one_change: null, change_kept: null, ...patch });
}

// Write every unsaved draft. Optimistic into the snapshot first; a failed write puts the text back.
function flushDrafts() {
  clearTimeout(ui.timer);
  ui.timer = null;
  const app = ui.app;
  if (!app?.snapshot) return;
  for (const [week, fields] of Object.entries(ui.drafts)) {
    const patch = {};
    for (const [f, text] of Object.entries(fields)) patch[f] = text.trim() === '' ? null : text;
    if (!Object.keys(patch).length) continue;
    delete ui.drafts[week];
    upsertReview(app, week, patch);
    let p;
    try { p = Promise.resolve(repo.saveReview(app.ctx, week, patch)); } catch (e) { p = Promise.reject(e); }
    p.then(() => {}, () => {
      ui.drafts[week] = { ...Object.fromEntries(Object.keys(patch).map((f) => [f, patch[f] ?? ''])), ...(ui.drafts[week] ?? {}) };
      ui.notice = 'Could not save your notes. They are kept here; try again.';
      if (document.querySelector('main')?.dataset.view === 'review') app.rerender?.();
    }).catch(() => {});
  }
}

const scheduleFlush = () => {
  clearTimeout(ui.timer);
  ui.timer = setTimeout(flushDrafts, SAVE_DELAY_MS);
};

// Typed text must survive tab switches and backgrounding.
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', flushDrafts);
  window.addEventListener('pagehide', flushDrafts);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDrafts(); });
}

function setKept(app, week, value) {
  flushDrafts();
  ui.notice = '';
  const next = reviewFor(app, week)?.change_kept === value ? null : value;
  upsertReview(app, week, { change_kept: next });
  app.rerender();
  let p;
  try { p = Promise.resolve(repo.saveReview(app.ctx, week, { change_kept: next })); } catch (e) { p = Promise.reject(e); }
  p.then(() => {}, () => { ui.notice = 'Could not save that. Try again.'; return app.refresh(); }).catch(() => {});
}

function stepWeek(app, delta) {
  flushDrafts();
  const w = addDays(shownWeek(app), 7 * delta);
  ui.week = w >= maxWeek(app) ? null : w; // null follows the current review week as days pass
  ui.notice = '';
  app.rerender();
}

// ---- pieces ----
const line = (label, value, sub) =>
  h('div', { class: 'rrow' },
    h('span', { class: 'rlabel' }, label),
    h('span', { class: 'num rval' }, value),
    sub ? h('span', { class: 'muted num rsub' }, sub) : null);

const numeral = (value, label) => h('div', { class: 'rnum' },
  h('span', { class: 'num-display' }, value), h('span', { class: 'label' }, label));

function stepper(app, week) {
  const btn = (delta, glyph, label, off) => h('button', {
    type: 'button', class: 'tap rstep', 'aria-label': label, disabled: off, onClick: () => stepWeek(app, delta),
  }, glyph);
  return h('div', { class: 'rsteps' },
    btn(-1, '‹', 'Previous week', week <= minWeek(app)),
    btn(1, '›', 'Next week', week >= maxWeek(app)));
}

function lastChange(app, week) {
  const prev = reviewFor(app, addDays(week, -7));
  const text = prev?.one_change?.trim();
  if (!text) return null;
  const kept = prev.change_kept;
  const pick = (value, label) => h('button', {
    type: 'button', class: `tap chip${kept === value ? ' is-done' : ''}`, 'aria-pressed': kept === value ? 'true' : 'false',
    onClick: () => setKept(app, prev.week_start, value),
  }, label);
  return h('section', { class: 'tsec', 'aria-label': 'Last week’s change' },
    h('div', { class: 'cap' }, 'Last week’s change'),
    h('p', { class: 'rchange' }, text),
    h('div', { class: 'rkept' }, h('span', { class: 'muted' }, 'Kept'), pick(true, 'Yes'), pick(false, 'No')));
}

function habitsBlock(m) {
  if (!m.habits.length) return h('p', { class: 'muted tempty' }, 'Add your habits in More.');
  return h('div', {}, m.habits.map((hb) => {
    const flags = [];
    if (hb.missedDays > 0) flags.push(`missed ${hb.missedDays}d`);
    if (hb.missedTwice > 0) flags.push(`missed twice ×${hb.missedTwice}`);
    return h('div', { class: 'rhabit' },
      h('div', { class: 'rrow' },
        h('span', { class: 'rlabel ellip' }, hb.name),
        h('span', { class: 'num rval' }, `${hb.hits}/${hb.target ?? dash}`),
        h('span', { class: 'muted num rsub' }, hb.since ? `since ${formatDayLabel(hb.since)}` : `28d ${fmtPct(hb.consistency28)}`)),
      flags.length ? h('div', { class: `rflags${hb.missedTwice > 0 ? ' danger' : ' muted'}` }, flags.join(' · ')) : null);
  }));
}

function textField(app, week, field, label) {
  const row = reviewFor(app, week);
  const value = ui.drafts[week]?.[field] ?? row?.[field] ?? '';
  const ta = h('textarea', {
    class: 'field rarea', rows: '3', 'data-draft': field, 'aria-label': label, autocomplete: 'off', autocapitalize: 'sentences',
  });
  ta.value = value;
  ta.addEventListener('input', () => {
    (ui.drafts[week] ??= {})[field] = ta.value;
    scheduleFlush();
  });
  ta.addEventListener('blur', flushDrafts);
  return h('label', { class: 'rprompt' }, h('span', { class: 'cap' }, label), ta);
}

export function renderReview(root, app) {
  ui.app = app;
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Review'), ...loadingNodes(app));
    return;
  }
  const focused = root.contains(document.activeElement) && document.activeElement.dataset?.draft ? document.activeElement : null;
  const focusField = focused?.dataset.draft ?? null;
  const caret = focused ? [focused.selectionStart, focused.selectionEnd] : null;
  syncToday(app);

  const week = shownWeek(app);
  const s = app.snapshot;
  const m = weeklyReview({
    weekStart: week, habits: s.habits ?? [], habitLogs: s.habitLogs ?? [], sleep: s.sleep ?? [],
    water: s.water ?? [], daily: s.daily ?? [], settings: s.settings,
  });
  const sl = m.sleep;

  root.replaceChildren(
    h('div', { class: 'review' },
      h('header', { class: 'rhead' },
        h('h1', {}, `Week of ${formatDayLabel(week)}`),
        stepper(app, week)),
      h('p', { class: 'muted rrange' }, `${formatDayLabel(m.weekStart)} ${dash} ${formatDayLabel(m.weekEnd)}`),
      lastChange(app, week),
      h('div', { class: 'rnums' },
        numeral(sl.avgMinutes == null ? dash : formatDuration(sl.avgMinutes), 'Sleep avg'),
        numeral(`${m.water.daysOnTarget}/${m.water.days}`, 'Water days')),
      h('section', { class: 'tsec', 'aria-label': 'Habits' }, h('div', { class: 'cap' }, 'Habits'), habitsBlock(m)),
      h('section', { class: 'tsec', 'aria-label': 'Health' },
        h('div', { class: 'cap' }, 'Health'),
        line('Sleep', sl.avgMinutes == null ? dash : formatDuration(sl.avgMinutes), sl.nights ? `${sl.nights} nights` : null),
        line('Bed time', sl.avgBed ?? dash, sl.bedSpreadMin == null ? null : `±${sl.bedSpreadMin} min`),
        line('Water', `${m.water.daysOnTarget}/${m.water.days}`, 'days on target')),
      h('section', { class: 'tsec rprompts', 'aria-label': 'Notes' },
        FIELDS.map(([f, label]) => textField(app, week, f, label))),
      ui.notice ? h('p', { class: 'danger tnotice', role: 'status' }, ui.notice) : null),
  );

  if (focusField) {
    const ta = root.querySelector(`textarea[data-draft="${focusField}"]`);
    if (ta) {
      try { ta.focus({ preventScroll: true }); if (caret?.[0] != null) ta.setSelectionRange(caret[0], caret[1]); } catch { /* ignore */ }
    }
  }
}
