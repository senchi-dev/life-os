// Routine editor (#/gym/routine/<id|new>) and weekly schedule editor (#/gym/schedule).
// routineActions is DOM-free: validate every row, mutate the snapshot optimistically, enqueue, roll back on failure.
// All user text (routine and exercise names) goes through h() as text nodes.
import { h } from './dom.js';
import { sheet } from './components.js';
import { loadingNodes } from './loading.js';
import { filterExercises, validateRoutineForm, validateRoutineItem, routineSaveOps, scheduleSaveOps, moveItem, ROUTINE_NAME_MAX } from '../lib/gym-forms.js';
import { validateGymRow } from '../lib/gym-validate.js';
import { enqueueGym, upsertRows } from '../data/gym-repo.js';

const FAIL = 'Could not save. Try again.';
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEFAULT_TARGET = { target_sets: '3', target_reps_min: '8', target_reps_max: '12' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

// UI-only state; survives re-renders, not reloads.
const ui = { notice: '', busy: false };
let savedTimer = null;

// The habit whose target_n follows the number of training days: settings.gym_habit_id when set (null = None chosen),
// else the habit called "Gym" (same fallback as ensureGymDefaults).
function gymHabitOf(snap) {
  const habits = snap.habits ?? [];
  const id = snap.settings?.gym_habit_id;
  if (id !== undefined) return habits.find((x) => x.id === id) ?? null;
  return habits.find((x) => String(x.name).trim().toLowerCase() === 'gym') ?? null;
}

const SNAP_KEYS = ['routines', 'routineItems', 'scheduleSlots', 'habits'];

export function routineActions(app, deps = {}) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const state = deps.ui ?? ui;
  const notify = (t) => { state.notice = t; };
  const flashSaved = () => {
    notify('Saved.');
    app.rerender();
    clearTimeout(savedTimer);
    // Clear the note in place when it is on screen: a repaint would drop focus from a field he is typing in.
    savedTimer = setTimeout(() => {
      if (state.notice !== 'Saved.') return;
      notify('');
      const el = typeof document !== 'undefined' ? document.querySelector('[data-rnotice]') : null;
      if (el) el.remove(); else app.rerender();
    }, 2500);
    savedTimer.unref?.();
  };

  // Validate every row first (nothing touches the snapshot if one is bad), then mutate, repaint, enqueue; roll back on failure.
  async function commit(ops, mutate) {
    for (const op of ops) {
      if (op.kind !== 'upsert') continue;
      for (const row of op.rows) {
        const reason = validateGymRow(op.table, row);
        if (reason) return { ok: false, error: `Invalid ${reason}` };
      }
    }
    const snap = app.snapshot;
    const before = Object.fromEntries(SNAP_KEYS.map((k) => [k, structuredClone(snap[k])]));
    notify('');
    mutate(snap);
    app.rerender();
    try {
      await enqueueGym(app.ctx, ops);
    } catch {
      if (app.snapshot === snap) for (const k of SNAP_KEYS) snap[k] = before[k];
      notify(FAIL);
      app.rerender();
      return { ok: true, saved: false };
    }
    flashSaved();
    return { ok: true, saved: true };
  }

  // The rows of a schedule write, as snapshot mutations (slots replaced, habit patched).
  const applySchedule = (ops) => (snap) => {
    snap.scheduleSlots = ops[0].rows;
    const patch = ops.find((o) => o.table === 'habits')?.rows[0];
    if (patch) snap.habits = (snap.habits ?? []).map((x) => (x.id === patch.id ? patch : x));
  };
  const userIdOf = () => app.snapshot.settings?.user_id ?? app.ctx?.userId;
  // 7 weekday slots from the stored ones, with `liveOnly` ids; unknown, archived or missing ids are rest.
  const sevenSlots = (pick) => {
    const live = new Set((app.snapshot.routines ?? []).filter((r) => !r.archived).map((r) => r.id));
    return [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
      const id = pick(weekday);
      return { weekday, routine_id: id != null && live.has(id) ? id : null };
    });
  };

  // id null creates a routine. form = { name, items: [{ id?, exercise_id, target_sets, target_reps_min, target_reps_max }] },
  // target fields may still be input strings. An empty items list is allowed.
  async function save(id, form) {
    const snap = app.snapshot;
    const old = id ? (snap.routines ?? []).find((r) => r.id === id) : null;
    if (id && !old) return { ok: false, error: 'Routine not found' };
    const named = validateRoutineForm({ name: form?.name }, snap.routines, id);
    if (!named.ok) return named;
    const rid = id ?? newId();
    const exName = (eid) => (snap.exercises ?? []).find((e) => e.id === eid)?.name ?? 'Exercise';
    const items = [];
    for (const raw of form?.items ?? []) {
      const v = validateRoutineItem(raw);
      if (!v.ok) return { ok: false, error: `${exName(raw.exercise_id)}: ${v.error}`, itemId: raw.id ?? null };
      items.push({ id: raw.id ?? newId(), routine_id: rid, exercise_id: raw.exercise_id, position: items.length, ...v.row });
    }
    const routine = { id: rid, name: named.row.name, sort: old ? old.sort : Math.max(-1, ...(snap.routines ?? []).map((r) => r.sort ?? 0)) + 1, archived: old ? !!old.archived : false };
    const removedItemIds = (snap.routineItems ?? []).filter((i) => i.routine_id === rid).map((i) => i.id);
    const ops = routineSaveOps({ routine, items, removedItemIds });
    const r = await commit(ops, (s) => {
      s.routines = old ? s.routines.map((x) => (x.id === rid ? { ...x, ...routine } : x)) : [...(s.routines ?? []), routine];
      s.routineItems = [...(s.routineItems ?? []).filter((i) => i.routine_id !== rid), ...items];
    });
    return r.ok && !id ? { ...r, id: rid } : r;
  }

  // Archive hides the routine; its schedule days turn into rest (one schedule write + the habit target), so nothing keeps
  // pointing at an archived routine. Hard delete is not offered: finished workouts keep a name copy and a nullable link.
  async function archive(id) {
    const snap = app.snapshot;
    const old = (snap.routines ?? []).find((r) => r.id === id);
    if (!old) return { ok: false, error: 'Routine not found' };
    const ops = [upsertRows('routines', [{ id, name: old.name, sort: old.sort ?? 0, archived: true }])];
    let applySlots = () => {};
    const slots = snap.scheduleSlots ?? [];
    if (slots.some((s) => s.routine_id === id)) {
      const next = [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
        const cur = slots.find((s) => s.weekday === weekday)?.routine_id ?? null;
        return { weekday, routine_id: cur === id ? null : cur };
      });
      const sops = await scheduleSaveOps({ slots: next, existing: slots, gymHabit: gymHabitOf(snap), userId: userIdOf() });
      ops.push(...sops);
      applySlots = applySchedule(sops);
    }
    return commit(ops, (s) => {
      s.routines = s.routines.map((x) => (x.id === id ? { ...x, archived: true } : x));
      applySlots(s);
    });
  }

  // slots: 7 { weekday, routine_id }. Archived or unknown routines are stored as rest.
  async function saveSchedule(slots) {
    let ops;
    try {
      const byDay = new Map((Array.isArray(slots) ? slots : []).map((s) => [s?.weekday, s.routine_id]));
      const clean = Array.isArray(slots) && slots.length === 7 ? sevenSlots((d) => byDay.get(d)) : slots;
      ops = await scheduleSaveOps({ slots: clean, existing: app.snapshot.scheduleSlots ?? [], gymHabit: gymHabitOf(app.snapshot), userId: userIdOf() });
    } catch {
      return { ok: false, error: 'Invalid schedule' };
    }
    return commit(ops, applySchedule(ops));
  }

  return { ui: state, save, archive, saveSchedule, notify };
}

// ---- view ----
const DEFAULT_ED = () => ({ key: null, name: '', items: [], error: '', errorItem: null, errorField: null });
let ed = null; // routine draft: { key, name, items[{id, exercise_id, position, target_*}], error, errorItem, errorField }
let sd = null; // schedule draft: { slots: [routine_id|null x 7] }
let picker = null;

function closePicker() {
  if (picker) { const p = picker; picker = null; p.close(); }
}

if (typeof addEventListener === 'function') {
  addEventListener('hashchange', () => {
    const hash = String(globalThis.location?.hash ?? '');
    if (!hash.startsWith('#/gym/routine/')) ed = null;
    if (!hash.startsWith('#/gym/schedule')) sd = null;
    closePicker();
  });
}

const back = (href, label) => h('a', { class: 'tap back', href }, label);
const notFound = (root, text, href = '#/gym', label = '‹ Gym') =>
  root.replaceChildren(h('div', { class: 'gym' }, back(href, label), h('h1', {}, text), h('p', { class: 'muted' }, 'It may have been archived or removed.')));

function notice() {
  return ui.notice ? h('p', { class: `tnotice${ui.notice === 'Saved.' ? ' muted' : ' danger'}`, role: 'status', 'data-rnotice': '' }, ui.notice) : null;
}

function loadDraft(app, id) {
  if (id === 'new') return { ...DEFAULT_ED(), key: id };
  const r = (app.snapshot.routines ?? []).find((x) => x.id === id && !x.archived);
  if (!r) return null;
  const items = (app.snapshot.routineItems ?? []).filter((i) => i.routine_id === id).sort((a, b) => a.position - b.position)
    .map((i) => ({ id: i.id, exercise_id: i.exercise_id, position: i.position, target_sets: String(i.target_sets), target_reps_min: String(i.target_reps_min), target_reps_max: String(i.target_reps_max) }));
  return { ...DEFAULT_ED(), key: id, name: r.name, items };
}

const exerciseOf = (app, eid) => (app.snapshot.exercises ?? []).find((e) => e.id === eid);

function openPicker(app, onPick) {
  closePicker();
  let query = '';
  const search = h('input', { class: 'field', type: 'search', 'aria-label': 'Search exercises', placeholder: 'Search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'sheet-list pick-list', role: 'group', 'aria-label': 'Exercises' });
  let s = null;
  const paint = () => {
    const found = filterExercises(app.snapshot.exercises ?? [], { query });
    list.replaceChildren(...(found.length
      ? found.map((e) => h('button', { type: 'button', class: 'tap sheetrow pickrow', onClick: () => { picker = null; s.close(); onPick(e); } },
        h('span', { class: 'exbody' },
          h('span', { class: 'ellip', lang: '' }, e.name),
          h('span', { class: 'muted ellip' }, [cap(e.muscle_group), e.equipment ? cap(e.equipment) : null].filter(Boolean).join(' · ')))))
      : [h('p', { class: 'muted exnone' }, 'No exercises match.')]));
  };
  search.addEventListener('input', () => { query = search.value; paint(); });
  s = sheet({
    title: 'Add exercise', body: [search, list],
    actions: [h('button', { type: 'button', class: 'tap grow', onClick: () => { picker = null; s.close(); } }, 'Cancel')],
    onClose: () => { picker = null; },
  });
  s.el.classList.add('sheet-form');
  picker = s;
  paint();
}

function targetInput(label, name, value, onInput, invalid) {
  const input = h('input', {
    class: 'field rnum', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '3', 'aria-label': `${label} for ${name}`, value,
    ...(invalid ? { 'aria-invalid': 'true' } : {}),
  });
  input.addEventListener('input', () => onInput(input.value));
  return h('label', { class: 'rtarget' }, h('span', { class: 'muted' }, label), input);
}

export function renderRoutine(root, app, id) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Routine'), ...loadingNodes(app));
    return undefined;
  }
  if (!ed || ed.key !== id) ed = loadDraft(app, id);
  if (!ed) { notFound(root, 'Routine not found'); return undefined; }
  const act = routineActions(app);
  const isNew = id === 'new';
  const list = h('ul', { class: 'row-list ritems', 'aria-label': 'Exercises in this routine' });
  const hint = h('p', { class: 'muted rhint' });
  const nameIn = h('input', {
    class: 'field', type: 'text', maxlength: String(ROUTINE_NAME_MAX), autocomplete: 'off', autocapitalize: 'words', lang: '',
    'aria-label': 'Routine name', placeholder: 'Routine name', value: ed.name,
    ...(ed.error && !ed.errorItem && /^Name/.test(ed.error) ? { 'aria-invalid': 'true' } : {}),
  });
  nameIn.addEventListener('input', () => { ed.name = nameIn.value; });
  const err = h('p', { class: 'danger tnotice', role: 'alert' });
  err.hidden = !ed.error;
  err.textContent = ed.error;
  const addBtn = h('button', { type: 'button', class: 'tap gbtn radd', onClick: () => openPicker(app, (e) => {
    ed.items = [...ed.items, { id: crypto.randomUUID(), exercise_id: e.id, position: ed.items.length, ...DEFAULT_TARGET }];
    paintItems();
    list.querySelector(`[data-ritem="${ed.items.at(-1).id}"] input`)?.focus();
  }) }, '+ Add exercise');

  const focusKey = (key) => list.querySelector(`[data-focus="${key}"]`)?.focus?.();
  function move(item, dir) {
    ed.items = moveItem(ed.items, item.id, dir);
    paintItems();
    const i = ed.items.findIndex((x) => x.id === item.id);
    // At an edge the pressed button becomes disabled: keep focus on the other arrow of the same row.
    if (dir === -1 && i === 0) focusKey(`${item.id}:down`); else if (dir === 1 && i === ed.items.length - 1) focusKey(`${item.id}:up`); else focusKey(`${item.id}:${dir === -1 ? 'up' : 'down'}`);
  }
  function remove(item) {
    const i = ed.items.findIndex((x) => x.id === item.id);
    ed.items = ed.items.filter((x) => x.id !== item.id).map((x, p) => ({ ...x, position: p }));
    paintItems();
    const next = ed.items[Math.min(i, ed.items.length - 1)];
    if (next) focusKey(`${next.id}:remove`); else addBtn.focus();
  }
  function paintItems() {
    ed.items = [...ed.items].sort((a, b) => a.position - b.position);
    hint.textContent = ed.items.length ? '' : 'No exercises yet. An empty routine starts an empty workout.';
    hint.hidden = ed.items.length > 0;
    list.replaceChildren(...ed.items.map((item, i) => {
      const ex = exerciseOf(app, item.exercise_id);
      const name = ex?.name ?? 'Unknown exercise';
      const bad = ed.errorItem === item.id;
      const btn = (key, label, text, onClick, disabled) => h('button', {
        type: 'button', class: 'tap rbtn', 'data-focus': `${item.id}:${key}`, 'aria-label': `${label} ${name}`, onClick, ...(disabled ? { disabled: true } : {}),
      }, text);
      return h('li', { class: 'ritem', 'data-ritem': item.id },
        h('div', { class: 'rrow1' },
          h('span', { class: 'exbody' }, h('span', { class: 'ellip exname', lang: '' }, name), h('span', { class: 'muted ellip' }, ex ? [cap(ex.muscle_group), ex.equipment ? cap(ex.equipment) : null].filter(Boolean).join(' · ') : '')),
          btn('up', 'Move up', '↑', () => move(item, -1), i === 0),
          btn('down', 'Move down', '↓', () => move(item, 1), i === ed.items.length - 1),
          btn('remove', 'Remove', '✕', () => remove(item))),
        h('div', { class: 'rtargets' },
          targetInput('Sets', name, item.target_sets, (v) => { item.target_sets = v; }, bad && ed.errorField === 'sets'),
          targetInput('Min reps', name, item.target_reps_min, (v) => { item.target_reps_min = v; }, bad && ed.errorField !== 'sets'),
          targetInput('Max reps', name, item.target_reps_max, (v) => { item.target_reps_max = v; }, bad && ed.errorField === 'max')));
    }));
  }

  const saveBtn = h('button', { type: 'button', class: 'tap primary rsave', onClick: submit }, 'Save');
  async function submit() {
    if (ui.busy) return;
    ui.busy = true;
    saveBtn.disabled = true;
    ed.error = '';
    ed.errorItem = null;
    let r;
    try { r = await act.save(isNew ? null : id, { name: ed.name, items: ed.items }); } finally { ui.busy = false; saveBtn.disabled = false; }
    if (!r.ok) {
      ed.error = r.error;
      ed.errorItem = r.itemId ?? null;
      ed.errorField = /Max reps/.test(r.error) ? 'max' : /Sets:/.test(r.error) ? 'sets' : 'min';
      app.rerender();
      queueMicrotask(() => {
        const target = ed?.errorItem ? root.querySelector(`[data-ritem="${ed.errorItem}"] input[aria-invalid="true"]`) : root.querySelector('input[aria-label="Routine name"]');
        target?.focus?.();
      });
      return;
    }
    if (!r.saved) return; // rolled back: the draft stays so he can retry
    ed = null;
    if (isNew && r.id) location.hash = `#/gym/routine/${r.id}`; else app.rerender();
  }
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  const inSchedule = (app.snapshot.scheduleSlots ?? []).filter((s) => s.routine_id === id).length;
  const archiveBtn = isNew ? null : h('button', { type: 'button', class: 'tap rarchive danger', onClick: () => confirmArchive() }, 'Archive routine');
  function confirmArchive() {
    const c = sheet({
      title: `Archive ${ed?.name || 'routine'}?`,
      body: h('p', { class: 'muted' }, inSchedule
        ? `It leaves the Gym list. ${plural(inSchedule, 'day')} in your schedule will become rest. Past workouts keep their name.`
        : 'It leaves the Gym list. Past workouts keep their name.'),
      actions: [
        h('button', { type: 'button', class: 'tap danger grow', onClick: async () => {
          const r = await act.archive(id);
          c.close();
          if (r.ok) { ed = null; location.hash = '#/gym'; }
        } }, 'Archive'),
        h('button', { type: 'button', class: 'tap', onClick: () => c.close() }, 'Cancel'),
      ],
    });
  }

  root.replaceChildren(h('div', { class: 'gym gym-routine' },
    back('#/gym', '‹ Gym'),
    h('header', { class: 'thead' }, h('h1', {}, isNew ? 'New routine' : 'Edit routine')),
    h('label', { class: 'mlabel' }, h('span', { class: 'muted' }, 'Name'), nameIn),
    h('h2', { class: 'cap rcap' }, 'Exercises'),
    list, hint, addBtn, err, notice(), saveBtn, archiveBtn));
  paintItems();
  return undefined;
}

export function renderSchedule(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Schedule'), ...loadingNodes(app));
    return undefined;
  }
  const act = routineActions(app);
  const routines = app.snapshot.routines ?? [];
  const live = routines.filter((r) => !r.archived).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const liveIds = new Set(live.map((r) => r.id));
  const stored = app.snapshot.scheduleSlots ?? [];
  const storedId = (d) => stored.find((s) => s.weekday === d)?.routine_id ?? null;
  if (!sd) sd = { slots: [1, 2, 3, 4, 5, 6, 7].map((d) => (liveIds.has(storedId(d)) ? storedId(d) : null)) };
  const count = h('p', { class: 'muted num', role: 'status' });
  const paintCount = () => {
    const n = sd.slots.filter((x) => x != null).length;
    count.textContent = `${plural(n, 'training day')} per week`;
  };
  const rows = DAYS.map((day, i) => {
    const sel = h('select', { class: 'field sselect', 'aria-label': `${day} routine` },
      h('option', { value: '' }, 'Rest'),
      live.map((r) => h('option', { value: r.id }, r.name)));
    sel.value = sd.slots[i] ?? '';
    sel.addEventListener('change', () => { sd.slots[i] = sel.value || null; paintCount(); });
    const sid = storedId(i + 1);
    const orphan = sid != null && !liveIds.has(sid);
    return h('li', { class: 'srow' },
      h('label', { class: 'slabel' }, h('span', { class: 'sday' }, day), sel),
      orphan ? h('p', { class: 'muted snote' }, 'Its routine was archived, so this day is rest. Save to apply.') : null);
  });
  const saveBtn = h('button', { type: 'button', class: 'tap primary rsave', onClick: async () => {
    if (ui.busy) return;
    ui.busy = true;
    saveBtn.disabled = true;
    try { await act.saveSchedule(sd.slots.map((routine_id, i) => ({ weekday: i + 1, routine_id }))); } finally { ui.busy = false; saveBtn.disabled = false; }
  } }, 'Save');
  root.replaceChildren(h('div', { class: 'gym gym-schedule' },
    back('#/gym', '‹ Gym'),
    h('header', { class: 'thead' }, h('h1', {}, 'Schedule')),
    h('p', { class: 'muted' }, 'Pick a routine for each weekday, or Rest. The Start button follows the rotation; this is the plan and the weekly count.'),
    h('ul', { class: 'row-list slist', 'aria-label': 'Weekly schedule' }, rows),
    count,
    live.length ? null : h('p', { class: 'muted' }, 'No routines yet. Create one first.'),
    notice(), saveBtn));
  paintCount();
  return undefined;
}
