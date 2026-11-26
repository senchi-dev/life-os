// Exercise screen (#/exercise/<id>): name, Edit, HISTORY in pages of 20 (sets fetched per page), HOW TO.
// Chart, 1RM and PR summary are phase 2b. Async work records into module state, then app.rerender() repaints once.
import { h } from './dom.js';
import { section } from './blocks.js';
import { loadingNodes } from './loading.js';
import { fetchSetsFor } from '../data/gym-repo.js';
import { exerciseHistoryPage, historyLine, setsForSession, HISTORY_PAGE } from './history-model.js';
import { newPager, beginPage, pageDone, pageFailed, hasMore, resetPager, pagerRows, leaveTracker } from './pager.js';
import { libraryActions, openExerciseSheet } from './library-view.js';

const LOAD_FAIL = 'Could not load. Try again.';

// Per open exercise: the pager (pages already loaded, in-flight, error), the index it was built against and the index wait.
// Reset on every fresh entry to the route and whenever the index object changes (a finished workout, a rebuild), so the
// list is never stale and offsets never shift under Load more.
const fresh = (id) => ({ id, pager: newPager(HISTORY_PAGE), index: null, idx: 'none' });
let st = fresh(null);
const leave = leaveTracker(() => { st = fresh(null); });

const idFromHash = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  if (parts[0] !== 'exercise' || !parts[1]) return null;
  try { return decodeURIComponent(parts[1]); } catch { return null; }
};
const onRoute = (id) => idFromHash() === id;

const back = () => h('a', { class: 'tap back', href: '#/gym/exercises' }, '\u2039 Exercises');

function ensureIndex(app) {
  const mine = st;
  if (app.gym?.index?.() || mine.idx !== 'none' || typeof app.gym?.ensureIndex !== 'function') return;
  mine.idx = 'pending';
  Promise.resolve().then(() => app.gym.ensureIndex()).then(() => {}, () => {}).finally(() => {
    mine.idx = 'done'; // one repaint, never a loop: a still-missing index shows the offline text until Try again
    if (st === mine && onRoute(mine.id)) app.rerender();
  });
}

// Loads the next page. In-flight and stale results are handled by the pager; any throw becomes the error state.
function loadPage(app, id) {
  const mine = st;
  const sessions = exerciseHistoryPage(app.gym?.index?.(), id, mine.pager.pages.length, HISTORY_PAGE);
  if (!sessions.length) return;
  const token = beginPage(mine.pager);
  if (!token) return;
  Promise.resolve().then(() => fetchSetsFor(app.ctx, sessions.flatMap((s) => s.weIds))).then((sets) => {
    pageDone(mine.pager, token, sessions.map((s) => ({ session: s, line: historyLine(s, setsForSession(s, sets), s.name) })));
  }).catch(() => {
    pageFailed(mine.pager, token);
  }).finally(() => {
    if (st === mine && onRoute(id)) app.rerender();
  });
}

const row = ({ session, line }) => h('li', {},
  h('a', { class: 'tap hv-row', href: `#/gym/history/${encodeURIComponent(session.workoutId)}` },
    h('span', { class: 'exbody' },
      h('span', { class: 'ellip' }, `${line.day} · `, h('span', { lang: '' }, line.name)),
      h('span', { class: 'num hv-line' }, line.sets)),
    h('span', { class: 'hv-side num' },
      line.pr ? h('span', { class: 'hv-pr' }, 'PR') : null,
      h('span', { class: 'muted' }, line.e1rm === '—' ? '—' : `e1RM ${line.e1rm}`))));

export function renderExercise(root, app) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Exercise'), ...loadingNodes(app));
    return undefined;
  }
  const id = idFromHash();
  const ex = id ? (app.snapshot.exercises ?? []).find((e) => e.id === id && !e.archived) : null;
  if (!ex) {
    root.replaceChildren(h('div', { class: 'gym' }, back(),
      h('h1', {}, 'Exercise not found'),
      h('p', { class: 'muted' }, 'It may have been archived or deleted.'),
      h('a', { class: 'tap gbtn hv-link', href: '#/gym/exercises' }, 'Back to exercises')));
    return undefined;
  }
  leave.enter();
  if (st.id !== id) st = fresh(id);

  const index = app.gym?.index?.() ?? null;
  if (st.index !== index) { resetPager(st.pager); st.index = index; }
  if (!index) ensureIndex(app);
  const total = index?.exercises && Object.prototype.hasOwnProperty.call(index.exercises, id) ? (index.exercises[id].sessions?.length ?? 0) : 0;
  const pg = st.pager;
  if (index && !pg.error && !pg.loading && pg.pages.length === 0 && !pg.exhausted && total > 0) loadPage(app, id);

  const act = libraryActions(app);
  let history;
  if (!index) {
    const waiting = st.idx === 'pending' && navigator.onLine !== false;
    history = waiting
      ? h('p', { class: 'muted', role: 'status' }, 'Loading history…')
      : [h('p', { class: 'muted', role: 'status' }, 'History loads when online.'),
        h('button', { type: 'button', class: 'tap', onClick: () => { st.idx = 'none'; app.rerender(); } }, 'Try again')];
  } else if (total === 0) {
    history = h('p', { class: 'muted' }, 'No sessions logged yet.');
  } else {
    const alive = new Set(index.workoutIds ?? []); // a workout deleted since this page was loaded drops out
    const rows = pagerRows(pg).filter((r) => alive.has(r.session.workoutId));
    const more = hasMore(pg, total);
    history = [
      rows.length ? h('ul', { class: 'row-list hv-list', 'aria-label': 'History' }, rows.map(row)) : null,
      pg.loading && !rows.length ? h('p', { class: 'muted', role: 'status' }, 'Loading\u2026') : null,
      pg.error ? h('p', { class: 'danger tnotice', role: 'status' }, LOAD_FAIL) : null,
      (more || (pg.error && !rows.length)) ? h('button', {
        type: 'button', class: 'tap hv-more', disabled: pg.loading ? '' : null,
        onClick: () => { loadPage(app, id); app.rerender(); },
      }, pg.loading ? 'Loading\u2026' : pg.error ? 'Try again' : 'Load more') : null,
    ];
  }

  root.replaceChildren(h('div', { class: 'gym gym-ex' },
    back(),
    h('header', { class: 'thead' },
      h('h1', { lang: '' }, ex.name),
      h('button', { type: 'button', class: 'tap chip', 'data-ex': ex.id, 'aria-label': `Edit ${ex.name}`, onClick: () => openExerciseSheet(app, act, ex) }, '⋯ Edit')),
    h('p', { class: 'muted' }, [ex.muscle_group, ex.equipment].filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' · ')),
    act.ui.notice ? h('p', { class: `tnotice${act.ui.notice === 'Saved.' ? ' muted' : ' danger'}`, role: 'status' }, act.ui.notice) : null,
    section({ title: 'History' }, history),
    section({ title: 'How to' },
      ex.how_to && String(ex.how_to).trim()
        ? h('p', { class: 'hv-howto', lang: '' }, ex.how_to)
        : h('p', { class: 'muted' }, 'No how-to yet. Add one with Edit.'))));
  return leave.cleanup;
}
