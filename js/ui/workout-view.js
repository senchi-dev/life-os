// Live workout screen (#/workout). DOM only: all decisions live in workout-model.js (pure, tested).
// Typing never re-renders the table (the keyboard would drop); a tick repaints its own row in place.
import { h, longPress } from './dom.js';
import { sheet, undoToast } from './components.js';
import { loadingNodes } from './loading.js';
import {
  workoutViewModel, staleSheetModel, parseKgInput, parseRepsInput, removeStep, opensTypePicker, LONG_PRESS_MS, TYPE_OPTIONS,
  createEditCommitter, stillCheckedText, finishSheetModel, resolveFinishEnd, finishDuration, endTimeMessage, untickedPrompt,
  habitCheckedText, sheetStash, shouldRestoreSheet, dismissStep, canOpenFinish, createGuard, applyFinishToSnapshot, applyDiscardToSnapshot, exerciseMenuModel, howToRow, customExerciseRow, noteError, finishVsStale, SESSION_NOTE_MAX, EXERCISE_NOTE_MAX,
} from './workout-model.js';
import { createTicker } from '../lib/ticker.js';
import { formatClock, endDurationKnown } from '../lib/workout.js';
import { filterExercises } from '../lib/gym-forms.js';
import { MUSCLE_GROUPS } from '../data/gym-seed.js';
import { nowHHMM } from '../lib/dates.js';
import { enqueueGym, upsertRows } from '../data/gym-repo.js';

export { workoutViewModel };

const REMOVE_ARM_MS = 3000;
const HINT_MS = 2800;
const NOTICE_MS = 8000;

const MESSAGES = {
  'kg-required': 'Enter the weight to log this set.',
  'reps-required': 'Enter the reps to log this set.',
  'bad-value': 'Use a number, like 82.5.',
  'bad-field': 'That field cannot be edited.',
  invalid: 'That value was not accepted.',
  'queue-failed': 'Could not save. Try again.',
  'no-draft': 'This workout is no longer open.',
  'has-done-sets': 'Not available once a set is done.',
};
const messageFor = (code) => MESSAGES[code] ?? 'Could not save. Try again.';

const pin = { workoutId: null, weId: null }; // the exercise the user tapped open (survives re-renders of this workout)
let staleRef = null; // the open blocking sheet, so a re-render never stacks a second one
let pickerRef = null; // the open set-type / menu / picker sheet
let finRef = null; // the open finish sheet: { close, busy, keep() }
let sheetKeep = null; // an editor sheet (how-to, note, picker) closed by a re-render, with what was typed
let finKeep = null; // a finish sheet closed by a re-render of this screen: reopened with what was typed
let noticeEl = null;
let activeToast = null;

// A plain notice (no action): used for app.gymNotice. One at a time, auto-dismisses.
export function showNotice(text) {
  noticeEl?.remove();
  const el = h('div', { class: 'toast', role: 'status' },
    h('span', { class: 'grow' }, text),
    h('button', { type: 'button', class: 'tap link', onClick: () => { el.remove(); if (noticeEl === el) noticeEl = null; } }, 'OK'));
  document.body.append(el);
  noticeEl = el;
  setTimeout(() => { el.remove(); if (noticeEl === el) noticeEl = null; }, NOTICE_MS);
}

// Shown once, whichever screen the app opens on, then cleared.
export function showGymNotice(app) {
  if (!app?.gymNotice) return;
  const text = app.gymNotice;
  app.gymNotice = null;
  showNotice(text);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const kgText = (v) => (v == null ? '' : String(v));
const TYPED_NAMES = { warmup: 'Warm-up set', dropset: 'Drop set', failure: 'Failure set' };
const ariaNameOf = (r) => TYPED_NAMES[r.type] ?? `Set ${r.label}`;

export function renderWorkout(root, app, hooks = {}) {
  const clock = hooks.now ?? (() => new Date());
  showGymNotice(app);
  if (!app.snapshot || app.gymReady === false) {
    root.replaceChildren(h('h1', {}, 'Workout'), ...loadingNodes(app));
    return undefined;
  }
  const gym = app.gym;
  if (!gym?.draft()) {
    // Nothing to log: replace (not push) so Back does not bounce here again.
    location.replace('#/gym');
    return undefined;
  }
  const first = gym.draft();
  if (pin.workoutId !== first.workout.id) { pin.workoutId = first.workout.id; pin.weId = null; }

  const exercisesById = Object.fromEntries((app.snapshot.exercises ?? []).map((e) => [e.id, e])); // same row objects as the snapshot
  const items = (app.snapshot.routineItems ?? []).filter((i) => i.routine_id && i.routine_id === first.workout.routine_id);
  const model = () => workoutViewModel(gym.draft(), { exercisesById, index: gym.index(), routineItems: items, activeWeId: pin.weId });

  const rowEls = new Map(); // setId -> row element
  const bodies = new Map(); // weId -> rows container
  const removeBtns = new Map(); // weId -> Remove button
  let armed = null; // { setId, timer }
  let hintTimer = null;
  let renderedActive = null;
  let pressCancels = [];
  const committer = createEditCommitter({
    current: (key) => { const [setId, field] = key.split(':'); return gym.draft()?.exercises.flatMap((e) => e.sets).find((x) => x.id === setId)?.[field]; },
    dispatch: async (key, value, meta) => {
      try {
        const res = await gym.dispatch({ kind: 'edit', weId: meta.weId, setId: meta.setId, field: meta.field, value });
        if (res.error) flash(meta.input, messageFor(res.error)); else refreshExercise(meta.weId);
        return res;
      } catch {
        // Never an unhandled rejection. The typed value stays in the input (not flagged invalid, so blur keeps it).
        flashHint(messageFor('queue-failed'));
        return { error: 'queue-failed' };
      }
    },
  });
  // Page hidden: the committed edit goes first, then the draft is persisted, so the stored draft has the edit.
  const persistAfterEdits = () => committer.flush().then(() => app.gym.flushDraft()).catch(() => {});
  const onHidden = () => { if (document.visibilityState === 'hidden') persistAfterEdits(); };
  document.addEventListener('visibilitychange', onHidden);
  addEventListener('pagehide', persistAfterEdits);

  // --- header, clock, summary --------------------------------------------------------------------------------
  const clockNode = document.createTextNode('');
  const summaryNode = document.createTextNode('');
  const ticker = createTicker(() => {
    const d = gym.draft();
    if (d) clockNode.data = formatClock(Date.now() - Date.parse(d.workout.started_at));
  });
  const hint = h('p', { class: 'wk-hint', role: 'status' });
  const flashHint = (text) => {
    hint.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.textContent = ''; }, HINT_MS);
  };
  const flash = (el, text) => {
    if (el) {
      el.setAttribute('aria-invalid', 'true');
      el.classList.remove('is-shake');
      void el.offsetWidth; // restart the animation
      el.classList.add('is-shake');
    }
    flashHint(text);
  };
  const unflag = (el) => { el.removeAttribute('aria-invalid'); el.classList.remove('is-shake'); };

  const minimize = () => { committer.flush(); location.hash = app.lastHash && !/^#\/?workout/.test(app.lastHash) ? app.lastHash : '#/today'; };
  const header = h('header', { class: 'wk-head' },
    h('button', { type: 'button', class: 'tap wk-min', 'aria-label': 'Minimize workout', onClick: minimize }, '⌄'),
    h('h1', { class: 'wk-title ellip', lang: '' }, ''),
    h('button', { type: 'button', class: 'tap wk-menu', 'aria-label': 'Workout options', 'aria-haspopup': 'dialog', onClick: () => openWorkoutMenu() }, '⋯'),
    h('button', { type: 'button', class: 'tap wk-finish', onClick: () => { if (hooks.onFinish) hooks.onFinish(); else openFinish(); } }, 'Finish'));
  const titleEl = header.querySelector('.wk-title');

  // --- rows --------------------------------------------------------------------------------------------------
  const findSet = (weId, setId) => {
    const we = gym.draft()?.exercises.find((e) => e.id === weId);
    return { we, set: we?.sets.find((s) => s.id === setId) };
  };
  const rowModel = (weId, setId) => model().exercises.find((e) => e.weId === weId)?.rows.find((r) => r.setId === setId);

  function paintRow(el, r) {
    const name = ariaNameOf(r);
    el.classList.toggle('is-done', r.done);
    el.classList.toggle('is-faint', r.faint);
    el.setAttribute('aria-label', `${name}, previous ${r.prev === '—' ? 'none' : r.prev}`);
    const num = el.querySelector('.wk-num');
    num.textContent = r.label;
    num.classList.toggle('is-typed', r.type !== 'normal');
    num.setAttribute('aria-label', `${name}, change type`);
    el.querySelector('.wk-prev').textContent = r.prev;
    const tick = el.querySelector('.wk-tick');
    tick.setAttribute('aria-pressed', String(r.done));
    tick.setAttribute('aria-label', `${name} done`);
    tick.classList.toggle('is-blocked', !r.canTick && !r.done);
    if (!r.canTick && !r.done) tick.setAttribute('aria-disabled', 'true'); else tick.removeAttribute('aria-disabled');
    el.querySelector('[data-field="kg"]').setAttribute('aria-label', `${name} weight in kilograms`);
    el.querySelector('[data-field="reps"]').setAttribute('aria-label', `${name} repetitions`);
  }

  function summaryPaint(m = model()) { summaryNode.data = m.summary; }

  function refreshExercise(weId) {
    const m = model();
    const ex = m.exercises.find((e) => e.weId === weId);
    if (ex) for (const r of ex.rows) { const el = rowEls.get(r.setId); if (el) paintRow(el, r); }
    summaryPaint(m);
    paintRemove(weId, m);
    // The active exercise moves on when one is completed: only then does the whole list rebuild.
    if (m.exercises.find((e) => e.expanded)?.weId !== renderedActive) renderList();
  }

  async function run(action, el) {
    const res = await gym.dispatch(action);
    if (res.error) flash(el, messageFor(res.error));
    return res;
  }

  async function onEdit(weId, setId, field, input) {
    const parsed = field === 'kg' ? parseKgInput(input.value) : parseRepsInput(input.value);
    if (parsed.kind === 'invalid') { flash(input, field === 'kg' ? 'Weight: use a number like 82.5.' : 'Reps: use a whole number.'); return; }
    unflag(input);
    const { set } = findSet(weId, setId);
    if (set?.done) { committer.input(`${setId}:${field}`, parsed.value, { weId, setId, field, input }); return; }
    const res = await run({ kind: 'edit', weId, setId, field, value: parsed.value }, input);
    if (!res.error) refreshExercise(weId);
  }

  // On blur: a flagged or unparseable cell falls back to the draft value; a good one is shown normalised ("82," -> 82).
  // Never reads the draft for a good cell, so an edit still in flight cannot be overwritten.
  function settleInput(weId, setId, field, input) {
    const parsed = field === 'kg' ? parseKgInput(input.value) : parseRepsInput(input.value);
    if (parsed.kind === 'invalid' || input.hasAttribute('aria-invalid')) {
      const { set } = findSet(weId, setId);
      if (set) input.value = kgText(set[field]);
    } else {
      input.value = kgText(parsed.value);
    }
    unflag(input);
  }

  async function onTick(weId, setId, tickEl) {
    committer.flush(); // an edit still waiting for its pause goes first
    const rowEl = rowEls.get(setId);
    const known = rowModel(weId, setId);
    if (!known) return;
    const wasDone = known.done;
    if (wasDone || known.canTick) {
      // Optimistic: paint the tick now, reconcile when the reducer answers.
      rowEl.classList.toggle('is-done', !wasDone);
      rowEl.classList.remove('is-faint');
      tickEl.setAttribute('aria-pressed', String(!wasDone));
      if (!wasDone) { rowEl.classList.remove('is-pop'); void rowEl.offsetWidth; rowEl.classList.add('is-pop'); }
    }
    const res = await run({ kind: wasDone ? 'untick' : 'tick', weId, setId }, !wasDone && !known.canTick ? missingCell(rowEl, known) : tickEl);
    if (res.error) {
      const r = rowModel(weId, setId);
      if (r) paintRow(rowEl, r);
      return;
    }
    refreshExercise(weId);
  }

  const missingCell = (rowEl, r) => rowEl.querySelector(r.kg == null ? '[data-field="kg"]' : '[data-field="reps"]');

  function openTypePicker(weId, setId, opener) {
    const r = rowModel(weId, setId);
    if (!r) return;
    committer.flush();
    const pick = async (type) => {
      s.close();
      if (r.type === type) return;
      const res = await run({ kind: 'setType', weId, setId, type }, opener);
      if (!res.error) refreshExercise(weId);
    };
    const s = sheet({
      title: `${ariaNameOf(r)} type`,
      body: h('div', { class: 'sheet-list' }, TYPE_OPTIONS.map((o) =>
        h('button', { type: 'button', class: 'tap sheetrow wk-typeopt', 'aria-pressed': String(o.type === r.type), onClick: () => pick(o.type) },
          h('span', { class: 'wk-typecode', 'aria-hidden': 'true' }, o.code ?? '#'), o.name))),
      onClose: () => { if (pickerRef === s) pickerRef = null; },
    });
    pickerRef = s;
  }

  function buildRow(weId, r) {
    // Select-all on focus: at once, and again on the next task (iOS Safari drops a selection made inside the focus event).
    const sel = (e) => {
      const t = e.currentTarget;
      t.dataset.fresh = '1';
      const all = () => { try { t.setSelectionRange(0, t.value.length); } catch { /* not selectable */ } };
      all();
      setTimeout(all, 0);
    };
    const input = (field, mode, value) => {
      const el = h('input', {
        type: 'text', class: 'field wk-in', inputmode: mode, autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next',
        'data-field': field, placeholder: '–',
        onFocus: sel, onInput: (e) => onEdit(weId, r.setId, field, e.currentTarget),
        onBlur: async (e) => { const t = e.currentTarget; await committer.flush(); settleInput(weId, r.setId, field, t); },
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } },
        onMouseup: (e) => { if (e.currentTarget.dataset.fresh) { delete e.currentTarget.dataset.fresh; e.preventDefault(); } },
      });
      el.value = kgText(value);
      return el;
    };
    const num = h('button', { type: 'button', class: 'tap wk-num', 'aria-haspopup': 'dialog',
      onClick: (e) => { if (e.detail === 0 && opensTypePicker('key', '')) openTypePicker(weId, r.setId, e.currentTarget); } });
    pressCancels.push(longPress(num, {
      ms: LONG_PRESS_MS,
      onHold: () => openTypePicker(weId, r.setId, num),
      onTap: (e) => { if (opensTypePicker('tap', e.pointerType)) openTypePicker(weId, r.setId, num); },
    }).cancel);
    const tick = h('button', { type: 'button', class: 'tap wk-tick', 'aria-pressed': 'false', onClick: (e) => onTick(weId, r.setId, e.currentTarget) },
      h('span', { class: 'wk-check', 'aria-hidden': 'true' }, '✓'));
    const row = h('div', { class: 'wk-row', role: 'group', 'data-set': r.setId },
      num, h('span', { class: 'wk-prev muted' }), input('kg', 'decimal', r.kg), input('reps', 'numeric', r.reps), tick);
    paintRow(row, r);
    rowEls.set(r.setId, row);
    return row;
  }

  // --- remove / add ------------------------------------------------------------------------------------------
  const disarm = () => { if (armed) { clearTimeout(armed.timer); armed = null; } };

  function paintRemove(weId, m = model()) {
    const btn = removeBtns.get(weId);
    const ex = m.exercises.find((e) => e.weId === weId);
    if (!btn || !ex) return;
    const last = ex.rows[ex.rows.length - 1];
    const isArmed = !!last && armed?.setId === last.setId && last.done;
    btn.textContent = isArmed ? 'Remove done set?' : 'Remove';
    btn.classList.toggle('is-armed', isArmed);
    btn.disabled = !last;
  }

  function toast(text, onUndo) {
    activeToast?.dismiss();
    activeToast = undoToast(text, onUndo, 5000);
  }

  async function onRemove(weId) {
    committer.flush();
    const ex = model().exercises.find((e) => e.weId === weId);
    const last = ex?.rows[ex.rows.length - 1];
    const step = removeStep(last ? { id: last.setId, done: last.done } : null, armed?.setId ?? null);
    if (step === 'none') return;
    if (step === 'arm') {
      disarm();
      armed = { setId: last.setId, timer: setTimeout(() => { armed = null; paintRemove(weId); }, REMOVE_ARM_MS) };
      paintRemove(weId);
      return;
    }
    disarm();
    const res = await run({ kind: 'removeSet', weId, setId: last.setId }, null);
    if (res.error) return;
    renderList();
    toast('Set removed', async () => {
      const u = await run({ kind: 'undo' }, null);
      if (!u.error) renderList();
    });
  }

  async function onAdd(weId) {
    committer.flush();
    const res = await run({ kind: 'addSet', weId }, null);
    if (res.error) return;
    renderList();
    const list = bodies.get(weId);
    list?.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  }

  // --- list --------------------------------------------------------------------------------------------------
  function exerciseNode(ex) {
    const meta = [ex.target, ex.lastTop ? `last ${ex.lastTop}` : null].filter(Boolean).join(' · ');
    if (!ex.expanded) {
      return h('section', { class: 'wk-ex is-collapsed', 'aria-label': ex.name },
        h('button', {
          type: 'button', class: 'tap wk-coll', 'aria-expanded': 'false',
          onClick: () => { pin.weId = ex.weId; renderList(); },
        }, h('span', { class: 'ellip wk-collname', lang: '' }, ex.name), meta ? h('span', { class: 'wk-collmeta muted ellip' }, meta) : null));
    }
    const rows = h('div', { class: 'wk-rows' }, ex.rows.map((r) => buildRow(ex.weId, r)));
    bodies.set(ex.weId, rows);
    const removeBtn = h('button', { type: 'button', class: 'tap wk-remove', onClick: () => onRemove(ex.weId) }, 'Remove');
    removeBtns.set(ex.weId, removeBtn);
    return h('section', { class: 'wk-ex is-open', 'aria-label': ex.name },
      h('div', { class: 'wk-exhead' },
        h('h2', { class: 'wk-exname', lang: '' }, ex.name),
        h('button', { type: 'button', class: 'tap wk-menu', 'data-menu': ex.weId, 'aria-label': `${ex.name} options`, 'aria-haspopup': 'dialog',
          onClick: () => openExerciseMenu(ex.weId) }, '⋯')),
      meta ? h('p', { class: 'wk-exmeta muted' }, meta) : null,
      ex.howTo ? h('p', { class: 'wk-howto muted', lang: '' }, ex.howTo) : null,
      h('button', { type: 'button', class: `tap wk-note${ex.note ? ' has-note' : ''}`, 'data-note': ex.weId, onClick: () => openExerciseNote(ex.weId) },
        ex.note ? h('span', { class: 'wk-notetext', lang: '' }, ex.note) : '+ Note for this session'),
      h('div', { class: 'wk-table' },
        h('div', { class: 'wk-thead cap', 'aria-hidden': 'true' },
          h('span', {}, 'Set'), h('span', {}, 'Prev'), h('span', {}, 'Kg'), h('span', {}, 'Reps'), h('span', {}, '✓')),
        rows),
      h('div', { class: 'wk-foot' },
        h('button', { type: 'button', class: 'tap wk-add', onClick: () => onAdd(ex.weId) }, '+ Add set'),
        removeBtn));
  }

  // --- overlays: one at a time ---------------------------------------------------------------------------------
  const closePicker = () => { if (pickerRef) { const p = pickerRef; pickerRef = null; p.close(); } };
  const refocus = (sel) => { try { list.querySelector(sel)?.focus({ preventScroll: true }); } catch { /* gone */ } };
  const menuSel = (weId) => `[data-menu="${CSS.escape(weId)}"]`;

  // Replace a sheet's content in place (keeps the focus trap and the opener): used for in-sheet steps.
  function swap(s, title, bodyNodes, actions) {
    s.el.setAttribute('aria-label', title);
    s.el.querySelector('.sheet-title').textContent = title;
    s.el.querySelector('.sheet-body').replaceChildren(...[].concat(bodyNodes));
    let bar = s.el.querySelector('.sheet-actions');
    if (!bar) { bar = h('div', { class: 'sheet-actions' }); s.el.append(bar); }
    bar.replaceChildren(...actions);
    (s.el.querySelector('input, textarea, select, button:not([disabled])') ?? s.el).focus();
  }

  const labelled = (text, el) => h('label', { class: 'mlabel' }, h('span', { class: 'muted' }, text), el);
  const errorLine = () => { const p = h('p', { class: 'danger tnotice', role: 'alert' }); p.hidden = true; return p; };
  const setError = (p, text) => { p.textContent = text; p.hidden = !text; };

  // --- exercise ⋯ menu -----------------------------------------------------------------------------------------
  function openExerciseMenu(weId) {
    const mm = exerciseMenuModel(gym.draft(), weId);
    if (!mm) return;
    committer.flush();
    closePicker();
    const we = gym.draft().exercises.find((e) => e.id === weId);
    const exercise = exercisesById[we.exercise_id];
    const choose = (id) => {
      s.close();
      if (id === 'howto') openHowTo(weId);
      else if (id === 'replace') openExercisePicker({ mode: 'replace', weId });
      else if (id === 'up' || id === 'down') moveExercise(weId, id === 'up' ? -1 : 1);
      else if (id === 'remove') removeExercise(weId);
    };
    const rows = mm.items.map((it) => h('button', {
      type: 'button', class: `tap sheetrow wk-menurow${it.danger ? ' danger' : ''}`, 'aria-disabled': it.disabled ? 'true' : null,
      onClick: () => { if (!it.disabled) choose(it.id); },
    }, h('span', { class: 'wk-menulabel' }, it.label), it.disabled && it.reason ? h('span', { class: 'wk-reason muted' }, it.reason) : null));
    const s = sheet({
      title: `${exercise?.name ?? 'Exercise'} options`,
      body: h('div', { class: 'sheet-list' }, rows),
      actions: [h('button', { type: 'button', class: 'tap grow', onClick: () => s.close() }, 'Close')],
      onClose: () => { if (pickerRef === s) pickerRef = null; },
    });
    s.el.querySelector('.sheet-title').lang = '';
    pickerRef = s;
  }

  // Escape / backdrop on an editor with unsaved text asks once more before it discards.
  const dismissGuard = (getState, err, isBusy = () => false) => {
    let armed = false;
    return () => {
      const step = dismissStep({ busy: isBusy(), dirty: !!sheetStash(getState()), armed });
      if (step === 'arm') { armed = true; setError(err, 'You have unsaved changes. Close again to discard them.'); return false; }
      return step !== 'ignore';
    };
  };

  function openHowTo(weId, restore = null) {
    const we = gym.draft()?.exercises.find((e) => e.id === weId);
    const exercise = we ? exercisesById[we.exercise_id] : null;
    if (!exercise) return;
    closePicker();
    const initial = exercise.how_to ?? '';
    const input = h('textarea', { class: 'field', rows: '6', maxlength: '2000', autocomplete: 'off', lang: '', 'aria-label': 'How to' });
    input.value = restore ?? initial;
    const err = errorLine();
    let busy = false;
    const save = async () => {
      if (busy) return;
      const r = howToRow(exercise, input.value);
      if (!r.ok) { setError(err, r.error); return; }
      busy = true;
      saveBtn.disabled = true;
      setError(err, '');
      const before = exercise.how_to ?? '';
      const snapRef = app.snapshot;
      exercise.how_to = r.row.how_to; // the logger reads this very row: it shows at once
      try {
        await enqueueGym(app.ctx, [upsertRows('exercises', [r.row])]);
      } catch {
        exercise.how_to = before;
        if (app.snapshot === snapRef) renderList();
        setError(err, 'Could not save. Try again.');
        busy = false;
        saveBtn.disabled = false;
        return;
      }
      busy = false;
      s.close();
      renderList();
      refocus(menuSel(weId));
    };
    const saveBtn = h('button', { type: 'button', class: 'tap primary grow', onClick: save }, 'Save');
    const s = sheet({
      title: 'Edit how-to', body: h('div', { class: 'mform' }, input, err),
      actions: [saveBtn, h('button', { type: 'button', class: 'tap', onClick: () => s.close() }, 'Cancel')],
      onDismiss: dismissGuard(() => s.state(), err, () => busy),
      onClose: () => { if (pickerRef === s) pickerRef = null; },
    });
    s.state = () => ({ kind: 'howto', weId, text: input.value, initial });
    s.el.classList.add('sheet-form');
    pickerRef = s;
  }

  async function moveExercise(weId, dir) {
    const res = await run({ kind: 'move', weId, dir }, null);
    if (res.error) return;
    renderList();
    refocus(menuSel(weId));
  }

  async function replaceExercise(weId, exercise) {
    const res = await run({ kind: 'replaceExercise', weId, exercise }, null);
    if (res.error) return;
    renderList();
    refocus(menuSel(weId));
  }

  async function removeExercise(weId) {
    const res = await run({ kind: 'removeExercise', weId }, null);
    if (res.error) return;
    if (pin.weId === weId) pin.weId = null;
    renderList();
    toast('Exercise removed', async () => {
      const u = await run({ kind: 'undo' }, null);
      if (!u.error) renderList();
    });
  }

  // --- per-exercise session note --------------------------------------------------------------------------------
  function openExerciseNote(weId, restore = null) {
    committer.flush();
    closePicker();
    const we = gym.draft()?.exercises.find((e) => e.id === weId);
    if (!we) return;
    const initial = we.note ?? '';
    const input = h('textarea', { class: 'field', rows: '4', maxlength: String(EXERCISE_NOTE_MAX), autocomplete: 'off', lang: '', 'aria-label': 'Note for this session' });
    input.value = restore ?? initial;
    const err = errorLine();
    const save = async () => {
      const bad = noteError(input.value, EXERCISE_NOTE_MAX);
      if (bad) { setError(err, bad); return; }
      const res = await run({ kind: 'exerciseNote', weId, text: input.value }, null);
      if (res.error) { setError(err, messageFor(res.error)); return; }
      s.close();
      renderList();
      refocus(`[data-note="${CSS.escape(weId)}"]`);
    };
    const s = sheet({
      title: 'Note for this session',
      body: h('div', { class: 'mform' }, input, err),
      actions: [h('button', { type: 'button', class: 'tap primary grow', onClick: save }, 'Save'), h('button', { type: 'button', class: 'tap', onClick: () => s.close() }, 'Cancel')],
      onDismiss: dismissGuard(() => s.state(), err),
      onClose: () => { if (pickerRef === s) pickerRef = null; },
    });
    s.state = () => ({ kind: 'note', weId, text: input.value, initial });
    s.el.classList.add('sheet-form');
    pickerRef = s;
  }

  // --- exercise picker (add / replace) with an inline "New exercise" --------------------------------------------
  function openExercisePicker({ mode, weId = null }, restore = null) {
    closePicker();
    const title = mode === 'replace' ? 'Replace exercise' : 'Add exercise';
    const onPick = (e) => (mode === 'replace' ? replaceExercise(weId, e) : addExercise(e));
    const search = h('input', { class: 'field', type: 'search', 'aria-label': 'Search exercises', placeholder: 'Search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    search.value = restore?.query ?? '';
    const results = h('div', { class: 'sheet-list pick-list', role: 'group', 'aria-label': 'Exercises' });
    let view = 'list';
    let nameEl = null;
    let muscleEl = null;
    const warn = errorLine(); // 'unsaved changes' line shared by both views
    const paint = () => {
      const found = filterExercises(app.snapshot.exercises ?? [], { query: search.value });
      results.replaceChildren(...(found.length
        ? found.map((e) => h('button', { type: 'button', class: 'tap sheetrow pickrow', onClick: () => { s.close(); onPick(e); } },
          h('span', { class: 'exbody' },
            h('span', { class: 'ellip', lang: '' }, e.name),
            h('span', { class: 'muted ellip' }, [cap(e.muscle_group), e.equipment ? cap(e.equipment) : null].filter(Boolean).join(' · ')))))
        : [h('p', { class: 'muted exnone' }, 'No exercises match.')]));
    };
    search.addEventListener('input', paint);
    const listView = () => {
      view = 'list'; nameEl = null; muscleEl = null;
      swap(s, title, [search, results, warn], [
        h('button', { type: 'button', class: 'tap primary grow', onClick: () => newView() }, 'New exercise'),
        h('button', { type: 'button', class: 'tap', onClick: () => s.close() }, 'Cancel'),
      ]);
      paint();
    };
    const newView = (vals = null) => {
      view = 'new';
      const name = h('input', { class: 'field', type: 'text', maxlength: '60', autocomplete: 'off', autocapitalize: 'sentences', lang: '', 'aria-label': 'Name' });
      const muscle = h('select', { class: 'field', 'aria-label': 'Muscle group' }, h('option', { value: '' }, 'Pick a muscle group'), MUSCLE_GROUPS.map((m) => h('option', { value: m }, cap(m))));
      if (vals) { name.value = vals.name ?? ''; muscle.value = vals.muscle ?? ''; }
      nameEl = name; muscleEl = muscle;
      const err = errorLine();
      let busy = false;
      const create = async () => {
        if (busy) return;
        const r = customExerciseRow({ name: name.value, muscle_group: muscle.value }, app.snapshot.exercises ?? [], () => crypto.randomUUID());
        if (!r.ok) {
          setError(err, r.error);
          name.setAttribute('aria-invalid', /^Name/.test(r.error) ? 'true' : 'false');
          muscle.setAttribute('aria-invalid', r.error === 'Pick a muscle group' ? 'true' : 'false');
          return;
        }
        busy = true;
        createBtn.disabled = true;
        setError(err, '');
        const snapRef = app.snapshot;
        const before = snapRef.exercises;
        snapRef.exercises = [...(before ?? []), r.row];
        exercisesById[r.row.id] = r.row;
        try {
          // The exercise row is queued before the workout row that points at it (foreign key order).
          await enqueueGym(app.ctx, [upsertRows('exercises', [r.row])]);
        } catch {
          if (app.snapshot === snapRef) snapRef.exercises = before;
          delete exercisesById[r.row.id];
          setError(err, 'Could not save. Try again.');
          busy = false;
          createBtn.disabled = false;
          return;
        }
        view = 'list'; // saved: nothing left to lose
        s.close();
        onPick(r.row);
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
      const createBtn = h('button', { type: 'button', class: 'tap primary grow', onClick: create }, 'Create and add');
      swap(s, 'New exercise', h('div', { class: 'mform' }, labelled('Name', name), labelled('Muscle group', muscle), err, warn),
        [createBtn, h('button', { type: 'button', class: 'tap', onClick: () => listView() }, 'Back')]);
    };
    const s = sheet({
      title, body: [],
      onDismiss: dismissGuard(() => s.state(), warn),
      onClose: () => { if (pickerRef === s) pickerRef = null; },
    });
    s.state = () => ({ kind: 'picker', mode, weId, query: search.value, view, name: nameEl?.value ?? '', muscle: muscleEl?.value ?? '' });
    s.el.classList.add('sheet-form');
    pickerRef = s;
    if (restore?.view === 'new') newView(restore); else listView();
  }

  async function addExercise(exercise) {
    const res = await run({ kind: 'addExercise', exercise }, null);
    if (res.error) return;
    const d = gym.draft();
    const added = d.exercises.reduce((m, e) => (e.position > m.position ? e : m), d.exercises[0]);
    pin.weId = added.id;
    renderList();
    refocus(menuSel(added.id));
    list.querySelector('.wk-ex.is-open')?.scrollIntoView?.({ block: 'start' });
  }

  // --- header ⋯: discard (two steps) -----------------------------------------------------------------------------
  function openWorkoutMenu() {
    closePicker();
    const discardBtn = h('button', { type: 'button', class: 'tap sheetrow danger', onClick: confirmStep }, 'Discard workout');
    const s = sheet({
      title: 'Workout options',
      body: h('div', { class: 'sheet-list' }, discardBtn),
      actions: [h('button', { type: 'button', class: 'tap grow', onClick: () => s.close() }, 'Close')],
      onClose: () => { if (pickerRef === s) pickerRef = null; },
    });
    pickerRef = s;
    function confirmStep() {
      const msg = errorLine();
      let busy = false;
      const yes = h('button', { type: 'button', class: 'tap primary grow wk-danger', onClick: async () => {
        if (busy) return;
        busy = true; yes.disabled = true;
        const ok = await discardNow(msg);
        if (ok) s.close(); else { busy = false; yes.disabled = false; }
      } }, 'Discard workout');
      swap(s, 'Discard this workout?', [h('p', { class: 'muted' }, 'Everything logged in it is deleted. This cannot be undone.'), msg],
        [yes, h('button', { type: 'button', class: 'tap', onClick: () => s.close() }, 'Keep it')]);
    }
  }

  // Shared by the header menu and the empty finish sheet. Resolves true when the workout is gone.
  async function discardNow(msgEl) {
    const day = gym.draft()?.workout.day;
    const id = gym.draft()?.workout.id;
    try {
      const r = await gym.discard();
      committer.cancel(); // only now: edits to a workout that is really gone are not worth saving
      if (id) applyDiscardToSnapshot(app.snapshot, id);
      location.hash = '#/today';
      if (r?.habitStillChecked) showNotice(stillCheckedText(day));
      return true;
    } catch {
      if (msgEl) setError(msgEl, 'Could not discard. Nothing was lost; try again.');
      return false;
    }
  }

  // --- finish sheet --------------------------------------------------------------------------------------------
  let opening = false;
  async function openFinish(keep = null) {
    if (!canOpenFinish({ finishOpen: !!finRef, finishBusy: !!finRef?.busy, staleOpen: !!staleRef, opening })) return; // never stacked, never while saving
    opening = true;
    try {
      closePicker();
      try { await committer.flush(); } catch { /* the committer reports its own failures */ }
      if (finRef || staleRef || !gym.draft()) return;
      buildFinishSheet(keep);
    } finally { opening = false; }
  }

  function buildFinishSheet(keep) {
    const draft = gym.draft();
    const m = finishSheetModel(draft, { now: clock(), prLines: gym.previewFinish() });
    const BLOCKED = new Error('blocked'); // a validation stop: its message is already on screen
    const handle = { busy: false, close: () => s.close(), keep: () => ({ note: noteIn.value, touched: state.touched, hhmm: state.hhmm, choice: state.choice }) };
    const state = { touched: !!keep?.touched, hhmm: keep?.hhmm ?? null, choice: keep?.choice ?? null };
    let saved = false;
    let afterBusy = () => {};
    const msg = errorLine();
    const noteIn = h('textarea', { class: 'field', rows: '3', maxlength: String(SESSION_NOTE_MAX), autocomplete: 'off', lang: '', 'aria-label': 'Session note', placeholder: 'How did it go?' });
    noteIn.value = keep?.note ?? draft.workout.note ?? '';

    const buttons = [];
    const btn = (cls, label, onClick) => { const el = h('button', { type: 'button', class: cls, onClick }, label); buttons.push(el); return el; };
    // One save at a time: every button is disabled while the promise is pending; a failure re-enables them.
    const guard = createGuard({
      setBusy: (b) => {
        handle.busy = b;
        if (b) { for (const x of buttons) x.disabled = true; setError(msg, ''); } else if (!saved) { for (const x of buttons) x.disabled = false; afterBusy(); }
      },
      onError: () => setError(msg, 'Could not save. Nothing was lost; try again.'),
      ignore: (e) => e === BLOCKED,
    });
    const guarded = (fn) => () => guard.run(fn);
    const done = (text) => { saved = true; s.close(); location.hash = '#/today'; if (text) showNotice(text); };

    let actions;
    let body;
    if (m.kind === 'empty') {
      const lost = untickedPrompt(m.unticked);
      body = h('div', { class: 'fin' },
        h('p', { class: 'muted' }, 'Nothing is ticked, so there is nothing to save.'),
        lost ? h('p', { class: 'muted' }, `${lost.text} with values will not be saved. Go back to tick them.`) : null,
        msg);
      actions = [
        btn('tap primary grow wk-danger', m.primary.label, guarded(async () => {
          if (!(await discardNow(msg))) throw BLOCKED;
          saved = true; s.close();
        })),
        btn('tap', m.secondary.label, () => s.close()),
      ];
    } else {
      const timeIn = h('input', { class: 'field', type: 'time', 'aria-label': 'Ended at', required: 'required' });
      timeIn.value = state.hhmm ?? nowHHMM(new Date(m.primary.end));
      const timeErr = errorLine();
      const durationNode = document.createTextNode(m.duration);
      const current = () => resolveFinishEnd({ draft: gym.draft() ?? draft, now: clock(), planEnd: m.primary.end, touched: state.touched, hhmm: timeIn.value });
      let primaryBtn = null;
      const refreshEnd = () => {
        const r = current();
        setError(timeErr, endTimeMessage(r.code));
        timeIn.setAttribute('aria-invalid', r.code ? 'true' : 'false');
        durationNode.data = r.end && !r.code ? finishDuration(draft.workout.started_at, r.end) : '—';
        if (primaryBtn) {
          primaryBtn.textContent = state.touched && m.kind === 'guarded' && r.end ? `End at ${timeIn.value}` : m.primary.label;
          primaryBtn.disabled = handle.busy || !!r.code; // an invalid end time blocks Save
        }
      };
      afterBusy = refreshEnd;
      timeIn.addEventListener('input', () => { state.touched = true; state.hhmm = timeIn.value; refreshEnd(); });

      const prompt = untickedPrompt(m.unticked);
      const choiceEls = [];
      const choiceBox = prompt ? h('div', { class: 'fin-choice', role: 'group', 'aria-label': prompt.text },
        h('p', { class: 'fin-choice-text' }, `${prompt.text}. Log them or discard them?`),
        h('div', { class: 'fin-choice-btns' }, prompt.choices.map((c) => {
          const el = btn('tap chip', c.label, () => {
            state.choice = c.logUnticked;
            for (const [x, e] of choiceEls) e.setAttribute('aria-pressed', String(x.logUnticked === state.choice));
            setError(msg, '');
          });
          el.setAttribute('aria-pressed', String(state.choice === c.logUnticked));
          choiceEls.push([c, el]);
          return el;
        }))) : null;

      const save = async (end, code) => {
        if (code) { setError(timeErr, endTimeMessage(code)); timeIn.focus(); throw BLOCKED; }
        const bad = noteError(noteIn.value, SESSION_NOTE_MAX);
        if (bad) { setError(msg, bad); noteIn.focus(); throw BLOCKED; }
        if (prompt && state.choice === null) { setError(msg, 'Choose what to do with the unticked sets.'); choiceEls[0][1].focus(); throw BLOCKED; }
        if (!gym.draft()) { done(null); return; } // closed elsewhere meanwhile
        const nr = await gym.dispatch({ kind: 'sessionNote', text: noteIn.value });
        if (nr.error) { setError(msg, messageFor(nr.error)); throw BLOCKED; }
        const r = await gym.finish({ end, durationKnown: endDurationKnown(draft.workout.started_at, end), logUnticked: state.choice === true });
        if (r?.workoutRow) applyFinishToSnapshot(app.snapshot, r, () => crypto.randomUUID());
        done(r?.habitChecked ? habitCheckedText(draft.workout.day) : null);
      };
      primaryBtn = btn('tap primary grow', m.primary.label, guarded(async () => { const r = current(); await save(r.end, r.code); }));
      actions = [primaryBtn];
      if (m.secondary) {
        const sec = m.secondary;
        actions.push(btn('tap', sec.label, guarded(async () => {
          const r = resolveFinishEnd({ draft: gym.draft() ?? draft, now: clock(), planEnd: sec.end, touched: false, hhmm: '' });
          await save(r.end, r.code);
        })));
      }
      actions.push(btn('tap', 'Back', () => s.close()));

      body = h('div', { class: 'fin' },
        m.kind === 'guarded' ? h('p', { class: 'muted fin-hint' }, 'This session looks left open. Ending at your last set keeps the duration honest.') : null,
        h('dl', { class: 'fin-stats' },
          h('div', {}, h('dt', { class: 'cap' }, 'Duration'), h('dd', { class: 'num' }, durationNode)),
          h('div', {}, h('dt', { class: 'cap' }, 'Sets'), h('dd', { class: 'num' }, String(m.sets)))),
        m.prs.length ? h('ul', { class: 'fin-prs', 'aria-label': 'Personal records' }, m.prs.map((t) => h('li', { lang: '' }, t))) : null,
        choiceBox,
        labelled('Session note', noteIn),
        labelled('Ended at', timeIn),
        timeErr,
        msg);
      queueMicrotask(refreshEnd);
    }

    const s = sheet({
      title: 'Finish workout',
      body,
      actions,
      onDismiss: () => dismissStep({ busy: handle.busy, dirty: false, armed: false }) !== 'ignore', // not while saving
      onClose: () => {
        if (finRef === handle) finRef = null;
        // Left without saving: what was typed in the note stays in the draft.
        if (!saved && !noteError(noteIn.value, SESSION_NOTE_MAX) && noteIn.value !== (gym.draft()?.workout.note ?? '')) {
          gym.dispatch({ kind: 'sessionNote', text: noteIn.value }).catch(() => {});
        }
      },
    });
    s.el.classList.add('sheet-form');
    finRef = handle;
  }

  const list = h('div', { class: 'wk-list' });
  function renderList() {
    const f = document.activeElement;
    const keep = f?.matches?.('.wk-in') ? { set: f.closest('.wk-row')?.dataset.set, field: f.dataset.field } : null;
    const m = model();
    pressCancels.forEach((c) => c()); pressCancels = [];
    rowEls.clear(); bodies.clear(); removeBtns.clear();
    list.replaceChildren(...m.exercises.map(exerciseNode));
    renderedActive = m.exercises.find((e) => e.expanded)?.weId ?? null;
    titleEl.textContent = m.title;
    summaryPaint(m);
    for (const ex of m.exercises) if (ex.expanded) paintRemove(ex.weId, m);
    if (keep) rowEls.get(keep.set)?.querySelector(`[data-field="${keep.field}"]`)?.focus({ preventScroll: true });
    if (!m.exercises.length) list.replaceChildren(h('p', { class: 'muted wk-empty' }, 'No exercises yet.'));
  }

  root.replaceChildren(h('div', { class: 'wk' },
    header,
    h('p', { class: 'wk-clock num-display', role: 'timer', 'aria-label': 'Elapsed time' }, clockNode),
    h('p', { class: 'wk-summary muted' }, summaryNode),
    hint,
    list,
    h('button', { type: 'button', class: 'tap wk-addex', onClick: () => openExercisePicker({ mode: 'add' }) }, '+ Add exercise')));
  renderList();
  ticker.start();
  if (app.gymStale) openStale(app, gym);
  // A re-render (data refresh) closed the finish sheet: bring it back with what was typed, unless the stale prompt took over.
  if (finKeep) { const k = finKeep; finKeep = null; if (!app.gymStale) openFinish(k); }
  // Same for an editor sheet with typed text, if what it belongs to still exists.
  if (sheetKeep) {
    const k = sheetKeep;
    sheetKeep = null;
    if (!app.gymStale && !staleRef && !finRef && !finKeep && shouldRestoreSheet(k, gym.draft(), exercisesById)) {
      if (k.kind === 'howto') openHowTo(k.weId, k.text);
      else if (k.kind === 'note') openExerciseNote(k.weId, k.text);
      else openExercisePicker({ mode: k.mode, weId: k.weId }, k);
    }
  }

  return () => {
    committer.flush().catch(() => {}); // no pending edit is lost on navigation or re-render
    document.removeEventListener('visibilitychange', onHidden);
    removeEventListener('pagehide', persistAfterEdits);
    // The finish sheet survives a re-render of this screen (not a navigation away), unless it is saving right now.
    if (finRef && !finRef.busy) {
      const f = finRef;
      finKeep = /^#\/?workout/.test(location.hash) ? f.keep() : null;
      f.close();
    }
    pressCancels.forEach((c) => c()); pressCancels = [];
    // An editor sheet with typed text comes back after the rebuild (not after leaving the screen).
    const stash = pickerRef?.state ? sheetStash(pickerRef.state()) : null;
    sheetKeep = stash && /^#\/?workout/.test(location.hash) ? stash : null;
    if (pickerRef) { const p = pickerRef; pickerRef = null; p.close(); }
    ticker.stop();
    disarm();
    clearTimeout(hintTimer);
    // The blocking sheet belongs to this screen; gymStale stays true, so coming back shows it again.
    if (staleRef) { const s = staleRef; staleRef = null; s.close(); }
  };
}

// --- stale draft: blocking "still open" sheet --------------------------------------------------------------------
function openStale(app, gym) {
  if (staleRef) return;
  // Overlays never stack: the blocking prompt takes over from an open finish sheet, but waits while one is being saved.
  const vs = finishVsStale({ finishOpen: !!finRef, finishBusy: !!finRef?.busy });
  if (vs === 'ignore') return;
  if (vs === 'close-finish') { finKeep = null; finRef.close(); }
  const draft = gym.draft();
  const m = staleSheetModel(draft, new Date().toISOString());
  if (!m) { app.gymStale = false; return; }
  let busy = false;
  let confirmDiscard = false;
  const msg = h('p', { class: 'wk-stale-msg danger', role: 'alert' });
  const done = (s) => { app.gymStale = false; staleRef = null; s.close(); location.hash = '#/gym'; };
  const guard = (fn) => async () => {
    if (busy) return;
    busy = true;
    for (const b of btns) b.disabled = true;
    msg.textContent = '';
    try { await fn(); } catch { msg.textContent = 'Could not save. Nothing was lost; try again.'; }
    busy = false;
    for (const b of btns) b.disabled = false;
  };
  const end = h('button', {
    type: 'button', class: 'tap primary',
    onClick: guard(async () => {
      const r = await gym.finish({ end: m.endIso, durationKnown: endDurationKnown(draft.workout.started_at, m.endIso), logUnticked: false });
      if (r?.workoutRow) applyFinishToSnapshot(app.snapshot, r, () => crypto.randomUUID());
      done(s);
    }),
  }, m.endLabel);
  const resume = h('button', { type: 'button', class: 'tap', onClick: () => {
      // Resume counts as activity: the prompt returns only after another 6 h.
      app.staleAck = { workoutId: draft.workout.id, at: new Date().toISOString() };
      app.gymStale = false; staleRef = null; s.close();
    },
  }, 'Resume');
  const discard = h('button', {
    type: 'button', class: 'tap danger',
    onClick: guard(async () => {
      if (!confirmDiscard) { confirmDiscard = true; discard.textContent = 'Discard workout? Tap again'; return; }
      const r = await gym.discard();
      applyDiscardToSnapshot(app.snapshot, draft.workout.id);
      done(s);
      if (r?.habitStillChecked) showNotice(stillCheckedText(draft.workout.day));
    }),
  }, 'Discard');
  const btns = [...(m.canEnd ? [end] : []), resume, discard];
  const s = sheet({
    title: m.title,
    blocking: true,
    body: h('div', {},
      h('p', { class: 'muted' }, m.canEnd ? 'It has been idle for hours. End it where your last set was, or keep going.' : 'Nothing was logged in it. Keep going or discard it.'),
      msg,
      h('div', { class: 'wk-stale-actions' }, btns)),
  });
  staleRef = s;
}
