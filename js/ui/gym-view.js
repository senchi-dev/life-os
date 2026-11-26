// Gym tab: home (start, week, schedule, routines, exercises, history), the exercise library, routine and schedule editors,
// and the past workout screen (history-view.js). The exercise screen is exercise-view.js; the live workout is workout-view.js.
import { h } from './dom.js';
import { guardedStart } from './start-guard.js';
import { loadingNodes } from './loading.js';
import { gymHomeModel } from './gym-model.js';
import { renderLibrary } from './library-view.js';
import { renderRoutine, renderSchedule } from './routine-view.js';
import { renderHistory } from './history-view.js';
import { openMoreSection } from './more-view.js';
import { formatDayLabel } from '../lib/dates.js';

const START_FAIL = 'Could not start the workout. Try again.';
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const ui = { notice: '', starting: false };

// '#/gym/routine/abc?x=1' -> ['gym', 'routine', 'abc'] (same rule as app.js routeParts; not imported to avoid a cycle).
const partsOf = (hash) => String(hash ?? '').replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function start(app, routineId) {
  if (ui.starting) return false;
  ui.starting = true;
  try {
    const d = await app.gym.start(routineId ?? null);
    if (d) { location.hash = '#/workout'; return true; }
    ui.notice = START_FAIL;
  } catch {
    ui.notice = START_FAIL;
  } finally {
    ui.starting = false;
  }
  app.rerender();
  return false;
}

const section = (label, aside, ...kids) =>
  h('section', { class: 'gsec', 'aria-label': label },
    h('div', { class: 'ghead' }, h('h2', { class: 'cap' }, label), aside ?? null),
    ...kids);

const linkRow = (href, main, sub) =>
  h('a', { class: 'tap grow-row', href },
    h('span', { class: 'exbody' }, h('span', { class: 'ellip', lang: '' }, main), sub ? h('span', { class: 'muted ellip' }, sub) : null),
    h('span', { class: 'mchev', 'aria-hidden': 'true' }, '›'));

function startBar(app, m) {
  const s = m.start;
  if (s.state === 'resume') {
    return h('a', { class: 'startbar gstart is-live', href: '#/workout', 'aria-label': `Resume ${s.name ?? 'workout'}` },
      h('span', { class: 'startmain' }, h('span', { class: 'ellip' }, `Resume${s.name ? ` · ${s.name}` : ''}`)));
  }
  return h('div', { class: 'gstartrow' },
    h('div', { class: 'startbar gstart' },
      h('button', { type: 'button', class: 'tap startmain', onClick: (e) => { guardedStart(e.currentTarget, () => start(app, s.routineId)); } },
        h('span', { class: 'ellip', lang: '' }, `Start workout${s.name ? ` · ${s.name}` : ''}`))),
    s.routineId ? h('button', { type: 'button', class: 'tap link gempty-link', onClick: (e) => { guardedStart(e.currentTarget, () => start(app, null)); } }, 'Empty workout') : null);
}

let indexWait = false;

function renderHome(root, app) {
  // The history index builds in the background; repaint once when it lands so sets and PRs fill in.
  if (!app.gym?.index?.() && !indexWait && app.gym?.ensureIndex) {
    indexWait = true;
    Promise.resolve(app.gym.ensureIndex()).then(() => { if (app.gym.index() && location.hash.replace(/^#\/?/, '').split('?')[0] === 'gym') app.rerender(); }, () => {}).finally(() => { indexWait = false; });
  }
  const m = gymHomeModel(app.snapshot, { draft: app.gym?.draft?.() ?? null, index: app.gym?.index?.() ?? null, todayKey: app.todayKey });
  const notice = ui.notice ? h('p', { class: 'danger tnotice', role: 'status' }, ui.notice) : null;

  if (m.empty) {
    root.replaceChildren(h('div', { class: 'gym' },
      h('h1', {}, 'Gym'),
      h('p', { class: 'muted' }, 'No routines or workouts yet.'),
      h('div', { class: 'gempty' },
        h('button', { type: 'button', class: 'tap primary', onClick: () => { openMoreSection('strive'); location.hash = '#/more'; } }, 'Import from Strive'),
        h('a', { class: 'tap gbtn', href: '#/gym/routine/new' }, 'New routine'),
        h('button', { type: 'button', class: 'tap gbtn', onClick: (e) => { guardedStart(e.currentTarget, () => start(app, null)); } }, 'Empty workout')),
      notice,
      section('Exercises', null, linkRow('#/gym/exercises', 'Exercises', plural(m.exerciseCount, 'exercise')))));
    return;
  }

  const dots = h('div', { class: 'gdots', role: 'img', 'aria-label': `${m.week.done} of ${m.week.plan} sessions this week` },
    m.week.dots.map((d, i) => h('span', { class: `gdot${d.done ? ' is-done' : d.planned ? ' is-planned' : ''}`, 'aria-hidden': 'true' }, DAY_LETTERS[i])));

  root.replaceChildren(h('div', { class: 'gym' },
    h('h1', {}, 'Gym'),
    startBar(app, m),
    notice,
    section('This week', h('span', { class: 'num muted' }, `${m.week.done} / ${m.week.plan}`), dots),
    section('Schedule', null, linkRow('#/gym/schedule', m.schedule || 'No schedule set', 'Mon to Sun')),
    section('Routines', h('a', { class: 'tap chip', href: '#/gym/routine/new' }, '+ New'),
      m.routines.length
        ? h('div', { class: 'glist' }, m.routines.map((r) => linkRow(`#/gym/routine/${r.id}`, r.name,
          [plural(r.count, 'exercise'), r.lastDay ? `last ${formatDayLabel(r.lastDay)}` : null].filter(Boolean).join(' · '))))
        : h('p', { class: 'muted' }, 'No routines yet.')),
    section('Exercises', null, linkRow('#/gym/exercises', 'Exercises', `${m.exerciseCount} · search, filter, add your own`)),
    section('History', null,
      m.history.length
        ? h('div', { class: 'glist' }, m.history.map((w) => linkRow(`#/gym/history/${w.id}`, `${formatDayLabel(w.day)} · ${w.name}`,
          [w.duration !== '—' ? w.duration : null, w.sets != null ? plural(w.sets, 'set') : null, w.prs ? plural(w.prs, 'PR') : null].filter(Boolean).join(' · '))))
        : h('p', { class: 'muted' }, 'No workouts in the last 6 weeks.'))));
}

// Which Gym screen a sub-route shows. `parts` is what follows 'gym' ('#/gym/routine/abc' -> ['routine', 'abc']).
// A Set, not an object: '#/gym/constructor' must not find Object.prototype members. Anything unknown is the home.
const SUBS = new Set(['exercises', 'routine', 'schedule', 'history']);
export function viewFor(parts) {
  const [sub, id] = Array.isArray(parts) ? parts : [];
  if (typeof sub !== 'string' || !SUBS.has(sub)) return { view: 'home' };
  if (sub === 'exercises' || sub === 'schedule') return { view: sub };
  return typeof id === 'string' && id ? { view: sub, id } : { view: 'home' };
}

// '%E0%A4%A' would make decodeURIComponent throw: a malformed id is shown as an unknown one.
const safeId = (id) => { try { return decodeURIComponent(id); } catch { return ''; } };

export function renderGym(root, app, hash = location.hash) {
  if (!app.snapshot) {
    root.replaceChildren(h('h1', {}, 'Gym'), ...loadingNodes(app));
    return undefined;
  }
  const [, ...rest] = partsOf(hash);
  const v = viewFor(rest);
  if (v.view === 'exercises') return renderLibrary(root, app);
  if (v.view === 'routine') return renderRoutine(root, app, v.id);
  if (v.view === 'schedule') return renderSchedule(root, app);
  if (v.view === 'history') return renderHistory(root, app, safeId(v.id));
  renderHome(root, app);
  return undefined;
}
