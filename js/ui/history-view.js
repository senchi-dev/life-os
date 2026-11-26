// Past workout detail (#/gym/history/<id>): header, each entry's sets, PR marks as stored, Delete workout.
// All text goes through h() as text nodes. The sets are fetched (the snapshot only holds workout rows, and only ~6 weeks).
import { h } from './dom.js';
import { sheet } from './components.js';
import { loadingNodes } from './loading.js';
import { enqueueGym, removeRow, fetchWorkoutsByIds } from '../data/gym-repo.js';
import { leaveTracker } from './pager.js';
import { workoutDetailModel, canDeleteWorkout, habitStillChecked, isUuid, deleteWarning } from './history-model.js';
import { stillCheckedText } from './workout-model.js';
import { showNotice } from './workout-view.js';

const DELETE_FAIL = 'Could not delete. Try again.';
const LOAD_FAIL = 'Could not load. Try again.';
const ACTIVE_MSG = 'Finish or discard it from the workout screen.';

let deleting = false;

// DOM-free: optimistic snapshot patch, queued remove (FK cascade drops entries and sets), then the history index.
// `fetched` is the workout row when it is older than the snapshot window. Resolves before the network is touched;
// `settled` resolves once the queue flush and index rebuild are done (never rejects).
export function historyActions(app) {
  async function deleteWorkout(id, fetched = null) {
    if (deleting) return { ok: false, error: 'Already deleting.' };
    const snap = app.snapshot;
    const w = (snap?.workouts ?? []).find((x) => x.id === id) ?? (fetched && fetched.id === id ? fetched : null);
    if (typeof id !== 'string' || !id || !w) return { ok: false, error: 'Workout not found' };
    if (!canDeleteWorkout(w, { draft: app.gym?.draft?.() ?? null })) return { ok: false, error: ACTIVE_MSG };
    deleting = true;
    try {
      const habitNotice = habitStillChecked({ snapshot: snap, workout: w, index: app.gym?.index?.() ?? null });
      const before = snap.workouts;
      snap.workouts = before.filter((x) => x.id !== id);
      try {
        await enqueueGym(app.ctx, [removeRow('workouts', id)]);
      } catch {
        if (app.snapshot === snap) snap.workouts = before;
        return { ok: false, error: DELETE_FAIL };
      }
      app.gym?.forgetWorkout?.(id);
      const settled = (async () => {
        // The remove must reach the server before the index is rebuilt from it; offline, the next ensureIndex does it.
        try { await app.ctx.outbox.flush(); } catch { /* stays queued */ }
        try { if (app.ctx.outbox.pending() === 0) await app.gym?.rebuildIndex?.(); } catch { /* index stays flagged stale */ }
      })();
      return { ok: true, habitNotice, day: w.day, settled };
    } finally {
      deleting = false;
    }
  }
  return { deleteWorkout };
}

// The fetched detail of the open workout survives re-renders (one fetch per visit).
let det = { id: null, status: 'idle', data: null };
// Refetch on every fresh entry: a workout opened while in progress must not stay stale after it is finished.
const leave = leaveTracker(() => { det = { id: null, status: 'idle', data: null }; });

// Still on this workout's screen? (the id in the hash may be percent-encoded)
const onRoute = (id) => {
  const [r, sub, raw] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  try { return r === 'gym' && sub === 'history' && decodeURIComponent(raw ?? '') === id; } catch { return false; }
};

function load(app, id) {
  const mine = { id, status: 'loading', data: null };
  det = mine;
  const done = () => { if (det === mine && onRoute(id)) app.rerender(); };
  if (!isUuid(id)) { mine.status = 'missing'; return; }
  Promise.resolve().then(() => fetchWorkoutsByIds(app.ctx, [id])).then((r) => {
    if (det !== mine) return;
    const w = (r.workouts ?? []).find((x) => x.id === id);
    if (!w) mine.status = 'missing';
    else { mine.status = 'ready'; mine.data = { workout: w, workoutExercises: r.workoutExercises ?? [], sets: r.sets ?? [] }; }
    done();
  }, () => { if (det !== mine) return; mine.status = 'error'; done(); });
}

const back = () => h('a', { class: 'tap back', href: '#/gym' }, '‹ Gym');

function openDelete(app, act, w, opener) {
  let s = null;
  const err = h('p', { class: 'danger tnotice', role: 'alert' });
  err.hidden = true;
  const confirmBtn = h('button', { type: 'button', class: 'tap hv-danger grow', onClick: async () => {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    const r = await act.deleteWorkout(w.id, w);
    if (!r.ok) { confirmBtn.disabled = false; err.textContent = r.error; err.hidden = false; return; }
    det = { id: null, status: 'idle', data: null };
    s.close();
    location.hash = '#/gym';
    if (r.habitNotice) showNotice(stillCheckedText(r.day));
  } }, 'Delete workout');
  s = sheet({
    title: 'Delete this workout?',
    body: h('div', {}, h('p', { class: 'muted' }, deleteWarning(w)), err),
    actions: [confirmBtn, h('button', { type: 'button', class: 'tap', onClick: () => s.close() }, 'Cancel')],
    onClose: () => { if (opener?.isConnected) queueMicrotask(() => opener.focus?.()); },
  });
  s.el.classList.add('sheet-form');
}

export function renderHistory(root, app, id) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Workout'), ...loadingNodes(app));
    return undefined;
  }
  leave.enter();
  if (det.id !== id) load(app, id);
  const page = (...kids) => root.replaceChildren(h('div', { class: 'gym gym-hist' }, back(), ...kids));

  if (det.status === 'loading') { page(h('h1', {}, 'Workout'), h('p', { class: 'muted', role: 'status' }, 'Loading…')); return leave.cleanup; }
  if (det.status === 'missing') {
    page(h('h1', {}, 'Workout not found'), h('p', { class: 'muted' }, 'It may have been deleted.'));
    return leave.cleanup;
  }
  if (det.status === 'error') {
    page(h('h1', {}, 'Workout'), h('p', { class: 'danger tnotice', role: 'status' }, LOAD_FAIL),
      h('button', { type: 'button', class: 'tap primary', onClick: () => { det = { id: null, status: 'idle', data: null }; app.rerender(); } }, 'Try again'));
    return leave.cleanup;
  }

  const { workout, workoutExercises, sets } = det.data;
  const m = workoutDetailModel({ workout, workoutExercises, sets, exercises: app.snapshot.exercises ?? [] });
  const act = historyActions(app);
  const canDelete = canDeleteWorkout(workout, { draft: app.gym?.draft?.() ?? null });
  const del = canDelete ? h('button', { type: 'button', class: 'tap hv-delete', onClick: (e) => openDelete(app, act, workout, e.currentTarget) }, 'Delete workout') : null;

  page(
    h('h1', { lang: '' }, m.name),
    h('p', { class: 'muted num hv-meta' }, `${m.dayLabel} · ${m.duration}`),
    m.inProgress ? h('p', { class: 'muted' }, 'In progress. ', h('a', { href: '#/workout' }, 'Open the workout')) : null,
    m.note ? h('p', { class: 'hv-note', lang: '' }, m.note) : null,
    m.exercises.length
      ? m.exercises.map((e) => h('section', { class: 'gsec hv-ex', 'aria-label': e.name },
        h('h2', { class: 'hv-exname', lang: '' }, e.exerciseId && (app.snapshot.exercises ?? []).some((x) => x.id === e.exerciseId)
          ? h('a', { href: `#/exercise/${encodeURIComponent(e.exerciseId)}` }, e.name) : e.name),
        e.note ? h('p', { class: 'hv-note muted', lang: '' }, e.note) : null,
        e.sets.length
          ? h('ol', { class: 'hv-sets' }, e.sets.map((s) => h('li', { class: 'hv-set' },
            h('span', { class: 'hv-no num muted' }, s.code ?? String(s.num)),
            h('span', { class: 'num hv-text' }, s.text),
            s.pr ? h('span', { class: 'hv-pr' }, 'PR') : null)))
          : h('p', { class: 'muted' }, 'No sets logged.')))
      : h('p', { class: 'muted' }, 'No exercises logged.'),
    del);
  return leave.cleanup;
}
