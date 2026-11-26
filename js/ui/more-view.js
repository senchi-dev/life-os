// More tab: targets, habits, rituals, encrypted export, account, lost-phone runbook.
// Sections open in place, one at a time. Writes are optimistic and never block the UI.
import { h } from './dom.js';
import { loadingNodes } from './loading.js';
import { canActivate, MAX_ACTIVE_HABITS } from '../lib/habits.js';
import { DEFAULT_WATER_TARGET_L } from '../lib/health.js';
import { encryptExport, validatePassphrase, exportFileName } from '../lib/crypto-export.js';
import {
  validateWaterTarget, validateHabit, validateRitual,
  moveHabit, nextSort, scheduleLabel, WEEKDAY_NAMES, signOutWarning,
} from '../lib/more-forms.js';
import { sheet } from './components.js';
import { valueRow } from './blocks.js';
import { localDateKey } from '../lib/dates.js';
import * as repo from '../data/repo.js';
import { importBody, resetImport } from './import-view.js';
import { currentTheme, writeTheme, applyTheme, themeColor, applyThemeColor } from '../lib/theme.js';
import { currentLayout, writeLayout, applyLayout } from '../lib/layout.js';

// UI-only state; survives re-renders but not reloads. drafts: 'form.field' -> unsaved value.
const ui = {
  open: null, notice: null, drafts: {}, habitEdit: null, ritualEdit: null,
  confirmAll: false, confirmTimer: null, exporting: false, busyAccount: false,
};

// The passphrase lives only in these two DOM inputs (reused across renders), never in JS state.
let pass1 = null, pass2 = null;
function passFields() {
  if (!pass1) {
    const mk = (key, label) => h('input', {
      type: 'password', class: 'field', 'data-key': key, 'aria-label': label,
      autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false',
    });
    pass1 = mk('export.p1', 'Passphrase');
    pass2 = mk('export.p2', 'Repeat passphrase');
  }
  return [pass1, pass2];
}

const say = (section, text, kind = 'error') => { ui.notice = { section, text, kind }; };
const clearDrafts = (prefix) => { for (const k of Object.keys(ui.drafts)) if (k.startsWith(prefix)) delete ui.drafts[k]; };
const toPromise = (fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };

// Optimistic update, rerender, then the write; a failed write reloads from the server with a calm note.
function commit(app, section, mutate, write, failText = 'Could not save that. Try again.') {
  ui.notice = null;
  mutate(app.snapshot);
  app.rerender();
  toPromise(write).then(() => {}, () => { say(section, failText); return app.refresh(); }).catch(() => {});
}

// ---- field helpers ----
function control(key, { tag = 'input', initial = '', options = null, ...attrs }) {
  const el = h(tag, { class: 'field', 'data-key': key, ...attrs });
  if (options) for (const [v, text] of options) el.append(h('option', { value: v }, text));
  el.value = ui.drafts[key] ?? initial;
  el.addEventListener('input', () => { ui.drafts[key] = el.value; });
  return el;
}
const labelled = (text, el) => h('label', { class: 'mlabel' }, h('span', { class: 'muted' }, text), el);
const notice = (section) => (ui.notice?.section === section
  ? h('p', { class: `tnotice ${ui.notice.kind === 'error' ? 'danger' : 'muted'}`, role: 'status' }, ui.notice.text) : null);

// ---- Targets ----
function targetsBody(app) {
  const s = app.snapshot.settings;
  const submit = (e) => {
    e.preventDefault();
    const w = validateWaterTarget(ui.drafts['tg.water'] ?? String(s?.water_target_l ?? DEFAULT_WATER_TARGET_L));
    if (w.error) return say('targets', `Water: ${w.error}`), app.rerender();
    const patch = { water_target_l: w.value };
    clearDrafts('tg.');
    commit(app, 'targets', (snap) => { snap.settings = { ...(snap.settings ?? {}), ...patch }; }, () => repo.saveSettings(app.ctx, patch));
    say('targets', 'Saved.', 'info');
    app.rerender();
  };
  return h('form', { class: 'mform', onSubmit: submit, novalidate: true },
    labelled('Daily water target (L)', control('tg.water', { initial: String(s?.water_target_l ?? DEFAULT_WATER_TARGET_L), inputmode: 'decimal', autocomplete: 'off' })),
    notice('targets'),
    h('button', { type: 'submit', class: 'tap primary' }, 'Save'));
}

// ---- Habits ----
const habitRow = (hb) => ({
  id: hb.id, name: hb.name, schedule_kind: hb.schedule_kind, weekdays: hb.weekdays ?? null,
  target_n: hb.target_n ?? null, active: !!hb.active, sort: hb.sort ?? 0,
});
const sortedHabits = (s) => [...s.habits].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

function openHabitForm(hb) {
  clearDrafts('habit.');
  ui.notice = null;
  ui.habitEdit = hb ? hb.id : 'new';
  ui.drafts['habit.name'] = hb?.name ?? '';
  ui.drafts['habit.kind'] = hb?.schedule_kind ?? 'daily';
  ui.drafts['habit.days'] = [...(hb?.weekdays ?? [1, 2, 3, 4, 5])];
  ui.drafts['habit.n'] = String(hb?.target_n ?? 3);
}
function closeHabitForm() { clearDrafts('habit.'); ui.habitEdit = null; }

function toggleHabit(app, hb) {
  const turnOn = !hb.active;
  if (turnOn && !canActivate(app.snapshot.habits)) {
    say('habits', `Max ${MAX_ACTIVE_HABITS} active habits`);
    return app.rerender();
  }
  const row = { ...habitRow(hb), active: turnOn };
  commit(app, 'habits', () => { hb.active = turnOn; }, () => repo.saveHabit(app.ctx, row));
}

function moveHabitUi(app, hb, dir) {
  const changes = moveHabit(app.snapshot.habits, hb.id, dir);
  if (!changes.length) return;
  const byId = new Map(app.snapshot.habits.map((x) => [x.id, x]));
  const rows = changes.map((c) => ({ ...habitRow(byId.get(c.id)), sort: c.sort }));
  commit(app, 'habits', () => { for (const c of changes) byId.get(c.id).sort = c.sort; },
    () => Promise.all(rows.map((r) => repo.saveHabit(app.ctx, r))));
}

function submitHabit(app, e) {
  e.preventDefault();
  const r = validateHabit({
    name: ui.drafts['habit.name'], kind: ui.drafts['habit.kind'], weekdays: ui.drafts['habit.days'], targetN: ui.drafts['habit.n'],
  });
  if (r.error) return say('habits', r.error), app.rerender();
  const habits = app.snapshot.habits;
  const existing = ui.habitEdit === 'new' ? null : habits.find((x) => x.id === ui.habitEdit);
  let row, text = null;
  if (existing) {
    row = { ...habitRow(existing), ...r.value };
  } else {
    const fits = canActivate(habits);
    if (!fits) text = `Max ${MAX_ACTIVE_HABITS} active habits. Saved as inactive.`;
    row = { id: crypto.randomUUID(), ...r.value, active: fits, sort: nextSort(habits) };
  }
  closeHabitForm();
  commit(app, 'habits', (snap) => {
    if (existing) Object.assign(existing, row);
    else snap.habits.push({ ...row, created_at: new Date().toISOString() });
  }, () => repo.saveHabit(app.ctx, row));
  if (text) { say('habits', text); app.rerender(); }
}

function habitForm(app) {
  const kind = ui.drafts['habit.kind'];
  const days = ui.drafts['habit.days'];
  const kindSel = control('habit.kind', {
    tag: 'select', 'aria-label': 'Schedule',
    options: [['daily', 'Every day'], ['weekdays', 'Chosen days'], ['n_per_week', 'Times per week']],
  });
  kindSel.addEventListener('change', () => app.rerender());
  return h('form', { class: 'mform mform-in', onSubmit: (e) => submitHabit(app, e), novalidate: true },
    labelled('Name', control('habit.name', { maxlength: '40', autocomplete: 'off', autocapitalize: 'sentences' })),
    labelled('Schedule', kindSel),
    kind === 'weekdays' ? h('div', { class: 'mdays', role: 'group', 'aria-label': 'Days' },
      WEEKDAY_NAMES.map((name, i) => h('button', {
        type: 'button', class: `tap chip${days.includes(i + 1) ? ' is-done' : ''}`, 'aria-pressed': days.includes(i + 1) ? 'true' : 'false',
        'aria-label': name, onClick: () => {
          ui.drafts['habit.days'] = days.includes(i + 1) ? days.filter((d) => d !== i + 1) : [...days, i + 1];
          app.rerender();
        },
      }, name.slice(0, 1)))) : null,
    kind === 'n_per_week' ? labelled('Times per week', control('habit.n', {
      tag: 'select', options: [1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), String(n)]),
    })) : null,
    notice('habits'),
    h('div', { class: 'mactions' },
      h('button', { type: 'submit', class: 'tap primary' }, 'Save'),
      h('button', { type: 'button', class: 'tap', onClick: () => { closeHabitForm(); ui.notice = null; app.rerender(); } }, 'Cancel')));
}

function habitsBody(app) {
  const list = sortedHabits(app.snapshot);
  const editing = ui.habitEdit;
  return h('div', {},
    list.length ? null : h('p', { class: 'muted' }, 'No habits yet. Add the ones you want to track.'),
    list.map((hb, i) => h('div', { class: 'mrow' },
      h('button', { type: 'button', class: `mname${hb.active ? '' : ' is-off'}`, 'aria-label': `Edit ${hb.name}`, onClick: () => { openHabitForm(hb); app.rerender(); } },
        h('span', { class: 'ellip' }, hb.name), h('span', { class: 'muted ellip' }, scheduleLabel(hb))),
      h('button', { type: 'button', class: 'tap', 'aria-label': `Move ${hb.name} up`, disabled: i === 0, onClick: () => moveHabitUi(app, hb, -1) }, '↑'),
      h('button', { type: 'button', class: 'tap', 'aria-label': `Move ${hb.name} down`, disabled: i === list.length - 1, onClick: () => moveHabitUi(app, hb, 1) }, '↓'),
      h('button', {
        type: 'button', class: `tap chip${hb.active ? ' is-done' : ''}`, 'aria-pressed': hb.active ? 'true' : 'false',
        'aria-label': `${hb.name} active`, onClick: () => toggleHabit(app, hb),
      }, hb.active ? 'On' : 'Off'))),
    editing ? habitForm(app) : [
      notice('habits'),
      h('button', { type: 'button', class: 'tap madd', onClick: () => { openHabitForm(null); app.rerender(); } }, 'Add habit')]);
}

// ---- Rituals ----
function openRitualForm(r) {
  clearDrafts('ritual.');
  ui.notice = null;
  ui.ritualEdit = r.id;
  ui.drafts['ritual.name'] = r.name;
  ui.drafts['ritual.weekday'] = String(r.weekday);
  ui.drafts['ritual.time'] = r.time ?? '09:00';
  ui.drafts['ritual.list'] = (r.checklist ?? []).join('\n');
}
function closeRitualForm() { clearDrafts('ritual.'); ui.ritualEdit = null; }

function submitRitual(app, e) {
  e.preventDefault();
  const r = validateRitual({
    name: ui.drafts['ritual.name'], weekday: ui.drafts['ritual.weekday'], time: ui.drafts['ritual.time'], checklistText: ui.drafts['ritual.list'],
  });
  if (r.error) return say('rituals', r.error), app.rerender();
  const existing = app.snapshot.rituals.find((x) => x.id === ui.ritualEdit);
  if (!existing) { closeRitualForm(); return app.rerender(); }
  const row = { id: existing.id, ...r.value };
  closeRitualForm();
  commit(app, 'rituals', () => { Object.assign(existing, row); }, () => repo.saveRitual(app.ctx, row));
}

function ritualForm(app) {
  const daySel = control('ritual.weekday', { tag: 'select', 'aria-label': 'Day', options: WEEKDAY_NAMES.map((n, i) => [String(i + 1), n]) });
  return h('form', { class: 'mform mform-in', onSubmit: (e) => submitRitual(app, e), novalidate: true },
    labelled('Name', control('ritual.name', { maxlength: '40', autocomplete: 'off' })),
    h('div', { class: 'mpair' },
      labelled('Day', daySel),
      labelled('Time', control('ritual.time', { type: 'time' }))),
    labelled('Checklist, one step per line', control('ritual.list', { tag: 'textarea', rows: '8', autocomplete: 'off', autocapitalize: 'sentences' })),
    notice('rituals'),
    h('div', { class: 'mactions' },
      h('button', { type: 'submit', class: 'tap primary' }, 'Save'),
      h('button', { type: 'button', class: 'tap', onClick: () => { closeRitualForm(); ui.notice = null; app.rerender(); } }, 'Cancel')));
}

function ritualsBody(app) {
  const list = [...app.snapshot.rituals].sort((a, b) => a.weekday - b.weekday || String(a.time).localeCompare(String(b.time)));
  return h('div', {},
    list.length ? null : h('p', { class: 'muted' }, 'No rituals yet.'),
    list.map((r) => (ui.ritualEdit === r.id ? null : h('div', { class: 'mrow' },
      h('button', { type: 'button', class: 'mname', 'aria-label': `Edit ${r.name}`, onClick: () => { openRitualForm(r); app.rerender(); } },
        h('span', { class: 'ellip' }, r.name),
        h('span', { class: 'muted ellip num' }, `${WEEKDAY_NAMES[r.weekday - 1]} ${r.time ?? ''} · ${r.checklist.length} steps`))))),
    ui.ritualEdit ? ritualForm(app) : notice('rituals'));
}

// ---- Export ----
function download(file) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, class: 'mhidden' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearPassphrases() {
  if (pass1) pass1.value = '';
  if (pass2) pass2.value = '';
}

// Full reset of the More screen state (sign-out, auth loss): nothing typed may outlive the session.
export function resetMore() {
  resetImport();
  clearPassphrases();
  clearTimeout(ui.confirmTimer);
  Object.assign(ui, { open: null, notice: null, drafts: {}, habitEdit: null, ritualEdit: null, confirmAll: false, confirmTimer: null, exporting: false, busyAccount: false });
}

// Leaving the tab clears the passphrase fields.
if (typeof window !== 'undefined') window.addEventListener('hashchange', clearPassphrases);

async function runExport(app) {
  const [p1, p2] = passFields();
  const bad = validatePassphrase(p1.value, p2.value);
  if (bad) { say('export', bad); return app.rerender(); } // keep the fields so typos can be fixed
  ui.exporting = true;
  say('export', 'Encrypting…', 'info');
  app.rerender();
  try {
    let file;
    try {
      const data = await repo.exportAll(app.ctx);
      const text = await encryptExport(data, p1.value);
      file = new File([text], exportFileName(localDateKey(new Date())), { type: 'application/json' });
    } catch {
      say('export', 'Export failed. Nothing was saved. Try again.');
      return;
    }
    let cancelled = false;
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) {
        if (e?.name === 'AbortError') cancelled = true;
        else download(file); // e.g. NotAllowedError after the gesture expired: the file still exists
      }
    } else {
      download(file);
    }
    if (cancelled) ui.notice = null;
    else say('export', 'Export saved. Keep the passphrase in your password manager.', 'info');
  } finally {
    clearPassphrases();
    ui.exporting = false;
    app.rerender();
  }
}

function exportBody(app) {
  const [p1, p2] = passFields();
  return h('form', { class: 'mform', onSubmit: (e) => { e.preventDefault(); if (!ui.exporting) runExport(app); }, novalidate: true },
    h('p', { class: 'muted' }, 'One encrypted file with all your data. Without the passphrase it cannot be opened.'),
    labelled('Passphrase (12 characters or more)', p1),
    labelled('Repeat passphrase', p2),
    notice('export'),
    h('button', { type: 'submit', class: 'tap primary', disabled: ui.exporting }, ui.exporting ? 'Encrypting…' : 'Export encrypted file'));
}

// ---- Account ----
function accountBody(app) {
  const off = app.demo || !app.client || ui.busyAccount;
  const run = (fn) => {
    resetMore();
    ui.open = 'account';
    ui.busyAccount = true;
    app.rerender();
    return toPromise(fn).then(() => {}, () => {}).finally(() => { ui.busyAccount = false; });
  };
  // An open workout or unsynced changes are wiped by a sign-out: say so first (step 1: this sheet, step 2: its button).
  const guarded = (fn) => {
    const warning = signOutWarning({ hasDraft: !!app.gym?.draft(), pending: app.ctx?.outbox?.pending() ?? 0 });
    if (!warning) return run(fn);
    let s = null;
    s = sheet({
      title: 'Sign out?',
      body: h('p', { class: 'danger' }, warning),
      actions: [
        h('button', { type: 'button', class: 'tap', onClick: () => s.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'tap danger', onClick: () => { s.close(); run(fn); } }, 'Sign out anyway'),
      ],
    });
    return undefined;
  };
  const everywhere = () => {
    if (!ui.confirmAll) {
      ui.confirmAll = true;
      clearTimeout(ui.confirmTimer);
      ui.confirmTimer = setTimeout(() => { ui.confirmAll = false; if (app.mode === 'app') app.rerender(); }, 6000);
      return app.rerender();
    }
    guarded(() => app.signOutEverywhere());
  };
  return h('div', { class: 'mform' },
    app.demo ? h('p', { class: 'muted' }, 'Signing out is not available in demo mode.') : null,
    h('button', { type: 'button', class: 'tap mwide', disabled: off, onClick: () => guarded(() => app.signOut()) }, 'Sign out'),
    h('button', {
      type: 'button', class: `tap mwide${ui.confirmAll ? ' mconfirm' : ''}`, disabled: off, onClick: everywhere,
    }, ui.confirmAll ? 'Tap again to sign out everywhere' : 'Sign out everywhere'));
}

// ---- Runbook ----
const RUNBOOK = [
  "From any other device, open this app's address and log in with an email code.",
  'Open More → Account → Sign out everywhere. Every session is revoked.',
  'Anything still open on the lost phone stops working within an hour.',
];
const runbookBody = () => h('ol', { class: 'mlist' }, RUNBOOK.map((t) => h('li', {}, t)));

// ---- Appearance: layout and colours (per device, localStorage) ----
const LAYOUT_OPTIONS = [['list', 'Clean list'], ['tiles', 'Tiles'], ['big', 'Big type']];
const THEMES = [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']];
function prefStore() { try { return localStorage; } catch { return null; } }
function setTheme(value) {
  writeTheme(prefStore(), value);
  applyTheme(document.documentElement, value);
  const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  applyThemeColor(document, themeColor(value, prefersLight));
}
function setLayout(value) {
  writeLayout(prefStore(), value);
  applyLayout(document.documentElement, value);
}
// A labelled row of mutually exclusive buttons; the current one has aria-pressed="true".
function segmented(label, options, current, onPick) {
  return h('div', { class: 'mappear-row' },
    h('div', { class: 'mappear-label' }, label),
    h('div', { class: 'seg', role: 'group', 'aria-label': label },
      options.map(([v, text]) => h('button', {
        type: 'button', class: 'tap', 'aria-pressed': current === v ? 'true' : 'false',
        onClick: () => onPick(v),
      }, text))));
}
function appearanceRow(app) {
  const el = document.documentElement;
  const store = prefStore();
  return h('section', { class: 'msec mappear', 'aria-label': 'Appearance' },
    h('h2', { class: 'mappear-title' }, 'Appearance'),
    segmented('Layout', LAYOUT_OPTIONS, currentLayout(el, store), (v) => { setLayout(v); app.rerender(); }),
    segmented('Colours', THEMES, currentTheme(el, store), (v) => { setTheme(v); app.rerender(); }));
}

// ---- Gym rows: habit picker, routines, exercises, import ----
function gymHabitChoices(app) {
  const s = app.snapshot;
  const cur = s.settings?.gym_habit_id ?? null;
  const list = sortedHabits(s).filter((x) => x.active || x.id === cur);
  return { cur, list };
}

function setGymHabit(app, value) {
  const id = value === '' ? null : value;
  commit(app, 'gym', (snap) => { snap.settings = { ...(snap.settings ?? {}), gym_habit_id: id }; }, () => repo.saveSettings(app.ctx, { gym_habit_id: id }));
}

function gymRows(app) {
  const { cur, list } = gymHabitChoices(app);
  const sel = h('select', { class: 'field', 'aria-label': 'Gym habit', 'data-key': 'gym.habit' },
    h('option', { value: '' }, 'None'),
    list.map((x) => h('option', { value: x.id }, x.name)));
  sel.value = list.some((x) => x.id === cur) ? cur : '';
  sel.addEventListener('change', () => setGymHabit(app, sel.value));
  return h('section', { class: 'msec mgym', 'aria-label': 'Gym' },
    h('label', { class: 'mlabel mgrow' }, h('span', { class: 'sec-title' }, 'Gym habit'), sel,
      h('span', { class: 'muted' }, 'Finishing a workout checks this habit.')),
    notice('gym'),
    valueRow({ href: '#/gym', label: 'Routines', value: null }),
    valueRow({ href: '#/gym/exercises', label: 'Exercises', value: null }));
}

const striveBody = (app) => importBody(app);

// Lets other screens (Gym empty state) land on More with a section already open.
export function openMoreSection(id) { ui.open = id; ui.notice = null; }

// ---- shell ----
function sections(app) {
  const s = app.snapshot;
  const active = s.habits.filter((x) => x.active).length;
  return [
    ['targets', 'Targets', `${s.settings?.water_target_l ?? DEFAULT_WATER_TARGET_L} L`, targetsBody],
    ['habits', 'Habits', `${active} active`, habitsBody],
    ['rituals', 'Rituals', `${s.rituals.length}`, ritualsBody],
    ['strive', 'Import from Strive', '', striveBody],
    ['export', 'Export', '', exportBody],
    ['account', 'Account', '', accountBody],
    ['lost', 'If this phone is lost', '', runbookBody],
  ];
}

function toggleSection(app, id) {
  clearPassphrases();
  ui.open = ui.open === id ? null : id;
  ui.notice = null;
  ui.confirmAll = false;
  closeHabitForm();
  closeRitualForm();
  app.rerender();
}

export function renderMore(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'More'), ...loadingNodes(app));
    return;
  }
  const ae = document.activeElement;
  const focusKey = ae && root.contains(ae) ? ae.dataset?.key ?? null : null;
  const caret = focusKey && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;

  root.replaceChildren(
    h('div', { class: 'more' },
      h('h1', {}, 'More'),
      appearanceRow(app),
      gymRows(app),
      sections(app).map(([id, title, summary, body]) => {
        const open = ui.open === id;
        return h('section', { class: `msec${open ? ' is-open' : ''}`, 'aria-label': title },
          h('button', { type: 'button', class: 'tap blk-row', 'aria-expanded': open ? 'true' : 'false', onClick: () => toggleSection(app, id) },
            h('span', { class: 'ellip' }, title),
            summary ? h('span', { class: 'num blk-val' }, summary) : null,
            h('span', { class: 'mchev', 'aria-hidden': 'true' }, '›')),
          open ? h('div', { class: 'mbody' }, body(app)) : null);
      })));

  if (focusKey) {
    const el = root.querySelector(`[data-key="${focusKey}"]`);
    if (el) {
      try { el.focus({ preventScroll: true }); if (caret) el.setSelectionRange(caret[0], caret[1]); } catch { /* not a text control */ }
    }
  }
}
