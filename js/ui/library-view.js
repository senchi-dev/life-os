// Exercise library: search, muscle filter, list, create/edit sheet. All user text goes through h() as text nodes.
// Writes are optimistic through libraryActions (DOM-free): validate, mutate the snapshot, repaint, enqueue, roll back on failure.
import { h } from './dom.js';
import { sheet } from './components.js';
import { filterExercises, validateExerciseForm, canDeleteExercise } from '../lib/gym-forms.js';
import { validateGymRow } from '../lib/gym-validate.js';
import { MUSCLE_GROUPS, EQUIPMENT } from '../data/gym-seed.js';
import { enqueueGym, upsertRows, removeRow } from '../data/gym-repo.js';
import { loadingNodes } from './loading.js';

const FAIL = 'Could not save. Try again.';
// Focus target after the new-exercise sheet closes (the list is repainted, so the opener is a fresh node).
const NEW_FOCUS = '__new';
const SEARCH_FOCUS = '__search';

// Where focus goes when a sheet closes: the row if it is still listed (an archived row may be filtered out, a deleted
// one is gone), else the + New button, else the search field. Never the body. `has(key)` says whether a key is on screen.
export function focusTarget(id, has) {
  for (const key of [id, NEW_FOCUS, SEARCH_FOCUS]) if (key && has(key)) return key;
  return null;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// UI-only state; survives re-renders, not reloads.
const ui = { query: '', muscle: null, showArchived: false, notice: '', focusId: null };
let savedTimer = null;

export function libraryActions(app, deps = {}) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const state = deps.ui ?? ui;
  const notify = (t) => { state.notice = t; };
  const flashSaved = () => {
    notify('Saved.');
    app.rerender();
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { if (state.notice === 'Saved.') { notify(''); app.rerender(); } }, 2500);
    savedTimer.unref?.();
  };
  const find = (id) => (app.snapshot.exercises ?? []).find((e) => e.id === id);

  // Optimistic write of one exercise row. Invalid rows never touch the snapshot.
  async function write(row, mutate) {
    const reason = validateGymRow('exercises', row);
    if (reason) return { ok: false, error: `Invalid ${reason}` };
    const snap = app.snapshot;
    const before = structuredClone(snap.exercises);
    notify('');
    mutate(snap);
    app.rerender();
    try {
      await enqueueGym(app.ctx, [upsertRows('exercises', [row])]);
    } catch {
      if (app.snapshot === snap) snap.exercises = before;
      notify(FAIL);
      app.rerender();
      return { ok: true, saved: false };
    }
    flashSaved();
    return { ok: true, saved: true };
  }

  // id null creates a custom exercise; otherwise edits that row (is_custom and archived are kept).
  async function save(id, form) {
    const r = validateExerciseForm(form, app.snapshot.exercises, id);
    if (!r.ok) return r;
    const old = id ? find(id) : null;
    if (id && !old) return { ok: false, error: 'Exercise not found' };
    const row = { id: id ?? newId(), ...r.row, is_custom: old ? old.is_custom : true, archived: old ? !!old.archived : false };
    return write(row, (s) => {
      if (old) Object.assign(old, row);
      else s.exercises = [...(s.exercises ?? []), row];
    });
  }

  async function setArchived(id, archived) {
    const old = find(id);
    if (!old) return { ok: false, error: 'Exercise not found' };
    const row = { id, name: old.name, muscle_group: old.muscle_group, equipment: old.equipment ?? null, how_to: old.how_to ?? '', is_custom: old.is_custom, archived };
    return write(row, () => { old.archived = archived; });
  }

  // Delete needs the index loaded and no routine, draft or finished workout using it. The server is asked too (best
  // effort): a workout the index does not know about (e.g. warm-up-only sessions) must still block the delete.
  async function remove(id) {
    const ok = canDeleteExercise(id, { routineItems: app.snapshot.routineItems, index: app.gym?.index?.() ?? null, draft: app.gym?.draft?.() ?? null });
    if (!ok) return { ok: false, error: 'Archive it instead' };
    try {
      const used = await app.ctx.backend.select('workout_exercises', { eq: { exercise_id: id }, range: [0, 0] });
      if (used.length) return { ok: false, error: 'Archive it instead' };
    } catch {
      return { ok: false, error: 'Cannot check history offline. Archive it instead.' };
    }
    const snap = app.snapshot;
    const before = structuredClone(snap.exercises);
    notify('');
    snap.exercises = snap.exercises.filter((e) => e.id !== id);
    app.rerender();
    try {
      await enqueueGym(app.ctx, [removeRow('exercises', id)]);
    } catch {
      if (app.snapshot === snap) snap.exercises = before;
      notify(FAIL);
      app.rerender();
      return { ok: true, saved: false };
    }
    flashSaved();
    return { ok: true, saved: true };
  }

  return { ui: state, save, setArchived, remove, notify };
}

// ---- view ----
function labelled(text, el) {
  return h('label', { class: 'mlabel' }, h('span', { class: 'muted' }, text), el);
}

let openForm = null;

function closeForm() {
  if (openForm) { const f = openForm; openForm = null; f.close(); }
}

// One sheet for create (ex null) and edit.
export function openExerciseSheet(app, act, ex) {
  closeForm();
  const nameIn = h('input', { class: 'field', type: 'text', maxlength: '60', autocomplete: 'off', autocapitalize: 'sentences', lang: '', value: ex?.name ?? '' });
  const muscleSel = h('select', { class: 'field' },
    h('option', { value: '' }, 'Pick a muscle group'),
    MUSCLE_GROUPS.map((m) => h('option', { value: m }, cap(m))));
  muscleSel.value = ex?.muscle_group ?? '';
  const equipSel = h('select', { class: 'field' },
    h('option', { value: '' }, 'None'),
    EQUIPMENT.map((m) => h('option', { value: m }, cap(m))));
  equipSel.value = ex?.equipment ?? '';
  const howIn = h('textarea', { class: 'field', rows: '5', maxlength: '2000', autocomplete: 'off', lang: '' });
  howIn.value = ex?.how_to ?? '';
  const err = h('p', { class: 'danger tnotice', role: 'alert' });
  err.hidden = true;
  const showError = (text) => {
    err.textContent = text;
    err.hidden = !text;
    nameIn.setAttribute('aria-invalid', text && /^Name/.test(text) ? 'true' : 'false');
    muscleSel.setAttribute('aria-invalid', text === 'Pick a muscle group' ? 'true' : 'false');
  };
  let s = null;
  const finish = (id) => { act.ui.focusId = id; if (s) { openForm = null; s.close(); } };
  const submit = async () => {
    const r = await act.save(ex?.id ?? null, { name: nameIn.value, muscle_group: muscleSel.value, equipment: equipSel.value, how_to: howIn.value });
    if (!r.ok) { showError(r.error); return; }
    finish(ex?.id ?? NEW_FOCUS);
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  const deletable = ex && app.gym?.index?.() ? canDeleteExercise(ex.id, { routineItems: app.snapshot.routineItems, index: app.gym.index(), draft: app.gym.draft?.() ?? null }) : false;
  const body = h('form', { class: 'mform', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit(); } },
    labelled('Name', nameIn), labelled('Muscle group', muscleSel), labelled('Equipment', equipSel), labelled('How to', howIn), err);
  const actions = [
    h('button', { type: 'button', class: 'tap primary grow', onClick: submit }, 'Save'),
    h('button', { type: 'button', class: 'tap', onClick: () => s.close() }, 'Cancel'),
  ];
  const extra = ex ? [
    h('button', { type: 'button', class: 'tap', onClick: async () => { const r = await act.setArchived(ex.id, !ex.archived); if (r.ok) finish(ex.id); else showError(r.error); } }, ex.archived ? 'Unarchive' : 'Archive'),
    deletable ? h('button', { type: 'button', class: 'tap danger', onClick: () => confirmDelete(app, act, ex, s, showError) }, 'Delete') : null,
  ] : [];
  s = sheet({ title: ex ? 'Edit exercise' : 'New exercise', body, actions: [...actions, ...extra], onClose: () => {
    openForm = null;
    const id = act.ui.focusId;
    act.ui.focusId = null;
    queueMicrotask(() => {
      const a = document.activeElement;
      if (!id && a && a !== document.body) return; // Cancel/Escape: the sheet already returned focus to a live opener
      const at = (k) => document.querySelector(`[data-ex="${k}"]`);
      const key = focusTarget(id, (k) => !!at(k));
      if (key) at(key).focus();
    });
  } });
  s.el.classList.add('sheet-form');
  openForm = s;
  addEventListener('hashchange', closeForm, { once: true });
}

function confirmDelete(app, act, ex, parent, showError) {
  const c = sheet({
    title: `Delete ${ex.name}?`,
    body: h('p', { class: 'muted' }, 'This cannot be undone. Archive keeps it out of the list without deleting history.'),
    actions: [
      h('button', { type: 'button', class: 'tap primary grow', onClick: async () => { const r = await act.remove(ex.id); c.close(); if (r.ok) { act.ui.focusId = NEW_FOCUS; openForm = null; parent.close(); } else showError(r.error); } }, 'Delete'),
      h('button', { type: 'button', class: 'tap', onClick: () => c.close() }, 'Cancel'),
    ],
  });
}

export function renderLibrary(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Exercises'), ...loadingNodes(app));
    return undefined;
  }
  const act = libraryActions(app);
  const list = h('ul', { class: 'row-list exlist', 'aria-label': 'Exercises' });
  const count = h('p', { class: 'muted num', role: 'status' });
  const chips = [];

  const paint = () => {
    const items = filterExercises(app.snapshot.exercises ?? [], { query: ui.query, muscle: ui.muscle, includeArchived: ui.showArchived });
    count.textContent = `${items.length} exercise${items.length === 1 ? '' : 's'}`;
    list.replaceChildren(...(items.length
      ? items.map((e) => {
        const body = [
          h('span', { class: 'exbody' },
            h('span', { class: 'ellip exname', lang: '' }, e.name),
            h('span', { class: 'muted ellip' }, [cap(e.muscle_group), e.equipment ? cap(e.equipment) : null, e.archived ? 'Archived' : null].filter(Boolean).join(' · '))),
          h('span', { class: 'mchev', 'aria-hidden': 'true' }, '›'),
        ];
        // A live exercise opens its screen (history, how-to, Edit). An archived one has no screen: its row opens the sheet to unarchive.
        return h('li', {}, e.archived
          ? h('button', { type: 'button', class: 'tap exrow', 'data-ex': e.id, onClick: () => openExerciseSheet(app, act, e) }, ...body)
          : h('a', { class: 'tap exrow', 'data-ex': e.id, href: `#/exercise/${encodeURIComponent(e.id)}` }, ...body));
      })
      : [h('li', { class: 'muted exnone' }, 'No exercises match.')]));
    for (const [m, el] of chips) el.setAttribute('aria-pressed', ui.muscle === m ? 'true' : 'false');
  };

  const search = h('input', {
    class: 'field', type: 'search', 'aria-label': 'Search exercises', placeholder: 'Search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: ui.query, 'data-ex': SEARCH_FOCUS,
  });
  search.addEventListener('input', () => { ui.query = search.value; paint(); });
  const chipBtn = (m, text) => {
    const el = h('button', { type: 'button', class: 'tap chip', 'aria-pressed': 'false', onClick: () => { ui.muscle = ui.muscle === m ? null : m; paint(); } }, text);
    chips.push([m, el]);
    return el;
  };
  const archivedToggle = h('button', {
    type: 'button', class: 'tap chip', 'aria-pressed': ui.showArchived ? 'true' : 'false',
    onClick: (e) => { ui.showArchived = !ui.showArchived; e.currentTarget.setAttribute('aria-pressed', ui.showArchived ? 'true' : 'false'); paint(); },
  }, 'Archived');

  root.replaceChildren(h('div', { class: 'gym gym-lib' },
    h('a', { class: 'tap back', href: '#/gym' }, '‹ Gym'),
    h('header', { class: 'thead' }, h('h1', {}, 'Exercises'),
      h('button', { type: 'button', class: 'tap chip chip-strong', 'data-ex': NEW_FOCUS, onClick: () => openExerciseSheet(app, act, null) }, '+ New')),
    search,
    h('div', { class: 'chiprow', role: 'group', 'aria-label': 'Filter by muscle' }, MUSCLE_GROUPS.map((m) => chipBtn(m, cap(m))), archivedToggle),
    ui.notice ? h('p', { class: `tnotice${ui.notice === 'Saved.' ? ' muted' : ' danger'}`, role: 'status' }, ui.notice) : null,
    count, list));
  paint();
  return undefined; // a repaint (optimistic write, Saved. flash) must not close an open sheet; leaving the route does (hashchange)
}
