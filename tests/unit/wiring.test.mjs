// Static wiring checks on js/app.js. Each assertion looks at a specific region so it cannot pass by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const src = readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');

// Body of `name(...) {...}` found by brace matching from the first '{' after the signature.
function body(name) {
  const at = src.search(new RegExp(`(async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`));
  assert.ok(at >= 0, `${name} exists`);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced');
}

test('app.js builds the runtime and seeds gym defaults', () => {
  assert.match(src, /createGymRuntime\(/);
  assert.match(src, /ensureGymDefaults/);
  assert.match(src, /createIdbKv\(/);
  assert.match(src, /createMemoryKv\(/);
});

test('toLogin clears the gym state together with the outbox', () => {
  const b = body('async toLogin');
  assert.match(b, /\.gym\.clearAll\(\)/);
  assert.match(b, /outbox\.clear\(\)/);
});

test('draft is flushed on pagehide and when the page becomes hidden', () => {
  assert.match(src, /addEventListener\('pagehide'/);
  const vis = src.slice(src.indexOf("addEventListener('visibilitychange'"));
  assert.match(vis.slice(0, 600), /hidden/);
  assert.match(vis.slice(0, 600), /flushDraft/);
  assert.match(src.slice(src.indexOf("addEventListener('pagehide'"), src.indexOf("addEventListener('pagehide'") + 200), /flushDraft/);
});

test('the outbox drives #pending through onChange', () => {
  assert.match(src, /createOutbox\(\{[^}]*onChange:/);
  assert.match(src, /getElementById\('pending'\)/);
});

test('refresh loads gym state: init on first load, ensureIndex after every refresh', () => {
  const b = body('async refresh');
  assert.match(b, /\.gym\.init\(/);
  assert.match(b, /\.gym\.ensureIndex\(\)/);
  assert.doesNotMatch(b, /await\s+app\.gym\.ensureIndex/, 'ensureIndex must not block the refresh');
});

test('theme is read at boot and applied', () => {
  assert.match(src, /readTheme\(/);
  assert.match(src, /applyTheme\(/);
  assert.match(src, /themeColor\(/);
});

test('layout is read at boot and applied before the first render', () => {
  assert.match(src, /readLayout\(/);
  assert.match(src, /applyLayout\(document\.documentElement/);
  const apply = src.search(/applyLayout\(document\.documentElement/);
  const render = src.indexOf('rerender(');
  assert.ok(render >= 0 && apply < render, 'layout applied before the first rerender(');
});

test('a new service worker version reloads the app once (watchSwUpdate before register)', () => {
  assert.match(src, /watchSwUpdate\(navigator\.serviceWorker, document,/);
  const watch = src.search(/watchSwUpdate\(navigator\.serviceWorker/);
  const reg = src.search(/serviceWorker\.register\(/);
  assert.ok(watch >= 0 && watch < reg, 'watcher installed before register');
});

test('rerender mounts views through mountView and sets body[data-route]', () => {
  const b = body('rerender');
  assert.match(b, /mountView\(/);
  assert.match(b, /dataset\.route\s*=\s*route/);
});

test('minibar: one idempotent ticker, hidden on the workout route, stopped when inactive', () => {
  assert.match(src, /createTicker\(/);
  assert.match(src, /minibarText\(/);
  const b = src.slice(src.indexOf('const syncMinibar'), src.indexOf('const app = {'));
  assert.match(b, /route !== 'workout'/);
  assert.match(b, /minibarTicker\.stop\(\)/);
  assert.match(b, /minibarTicker\.start\(\)/);
  assert.equal((src.match(/setInterval\(/g) ?? []).length, 0, 'no ad-hoc interval in app.js');
});

test('workout route: gym readiness gate and the one-shot gym notice are wired', () => {
  assert.match(src, /gymReady: false/);
  assert.match(body('async refresh'), /app\.gymReady = true/);
  assert.match(body('async toLogin'), /app\.gymReady = false/);
  assert.match(body('rerender'), /showGymNotice\(app\)/);
  assert.match(body('rerender'), /app\.lastHash = /);
});

test('workout-view: blocking stale sheet, no raw HTML sink, names carry lang, tick/edit never rebuild the table', () => {
  const v = readFileSync(new URL('../../js/ui/workout-view.js', import.meta.url), 'utf8');
  assert.match(v, /blocking: true/);
  assert.equal(/inner\s*HTML|outer\s*HTML|insertAdjacentHTML/i.test(v), false);
  assert.ok((v.match(/lang: ''/g) ?? []).length >= 3);
  const edit = v.slice(v.indexOf('async function onEdit'), v.indexOf('// On blur'));
  assert.equal(/renderList\(/.test(edit), false, 'typing must not rebuild the list');
  assert.match(v, /location\.replace\('#\/gym'\)/);
  const sw = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
  for (const f of ['js/ui/workout-view.js', 'js/ui/workout-model.js', 'js/lib/ticker.js']) assert.ok(sw.includes(`'${f}'`), f);
});

test('stale draft is re-checked on render, on foreground (visibility + pageshow) and never shows the minibar on Today', () => {
  assert.match(body('rerender'), /checkStale\(route\)/);
  assert.match(src, /addEventListener\('pageshow', recheckStale\)/);
  const vis = src.slice(src.indexOf("addEventListener('visibilitychange'"));
  assert.match(vis.slice(0, 700), /recheckStale\(\)/);
  const b = src.slice(src.indexOf('const syncMinibar'), src.indexOf('const checkStale'));
  assert.match(b, /route !== 'today'/);
  assert.match(src, /needsStalePrompt\(/);
});

// ---- Task 22 audit: assertions that pin each audited wiring line (each was checked to fail with the line removed) ----
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const listJs = (d) => readdirSync(new URL(`../../${d}`, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`);

test('first load passes ensureGymDefaults to loadFirst; gym.init runs on the first load and the first live one after an offline boot', () => {
  const b = body('async refresh');
  assert.match(b, /loadFirst\(\{[^}]*\bensureGymDefaults\b[^}]*\}\)/);
  const at = b.indexOf('if (!app.gymReady || (wasCached && !cached))');
  assert.ok(at >= 0, 'init guard');
  const first = b.slice(at);
  assert.match(first.slice(0, first.indexOf('app.gymReady = true')), /app\.gym\.init\(\{ cached \}\)/);
  assert.equal((src.match(/\.gym\.init\(/g) ?? []).length, 1, 'gym.init is called in one place only');
});

test('toLogin clears gym state and the outbox only inside the clear branch', () => {
  const b = body('async toLogin');
  const at = b.indexOf('if (clear)');
  assert.ok(at >= 0, 'clear branch');
  const branch = b.slice(at, b.indexOf('}', b.indexOf('{', at)) + 1);
  assert.match(branch, /app\.gym\.clearAll\(\)/);
  assert.match(branch, /outbox\.clear\(\)/);
  assert.equal((b.match(/clearAll\(\)/g) ?? []).length, 1, 'no clearAll outside the clear branch');
});

test('toLogin clear branch resets the calendar', () => {
  const b = body('async toLogin');
  const at = b.indexOf('if (clear)');
  assert.ok(at >= 0, 'clear branch');
  const branch = b.slice(at, b.indexOf('}', b.indexOf('{', at)) + 1);
  assert.match(branch, /resetCalendar\(\)/);
});

test('VIEWS maps the gym, workout and exercise routes to their views', () => {
  const v = src.slice(src.indexOf('const VIEWS = {'), src.indexOf('};', src.indexOf('const VIEWS = {')));
  assert.match(v, /gym: renderGym/);
  assert.match(v, /workout: renderWorkout/);
  assert.match(v, /exercise: renderExercise/);
  const routes = src.slice(src.indexOf('const ROUTES'), src.indexOf('];', src.indexOf('const ROUTES')));
  for (const r of ['gym', 'workout', 'exercise']) assert.ok(routes.includes(`'${r}'`), r);
});

test('every route change syncs the minibar', () => {
  assert.match(body('rerender'), /syncMinibar\(route\)/);
  assert.match(body('async toLogin'), /syncMinibar\(\)/);
});

test('theme is applied before anything is rendered', () => {
  const s = body('function start');
  const applied = s.indexOf('applyTheme(document.documentElement');
  assert.ok(applied >= 0, 'applyTheme on <html>');
  for (const later of ['app.toApp()', 'renderAuth(', 'createOutbox(']) {
    const at = s.indexOf(later);
    if (at >= 0) assert.ok(applied < at, `theme before ${later}`);
  }
});

test('every Start tap is guarded: guardedStart (disabled after the tap) or a sheet row that closes before starting', () => {
  const sites = { 'js/ui/today-view.js': /act\.startWorkout\(/, 'js/ui/gym-view.js': /\bstart\(app,/ };
  for (const [f, re] of Object.entries(sites)) {
    const lines = read(f).split('\n').filter((l) => re.test(l) && !/async function/.test(l));
    assert.ok(lines.length >= 1, `${f} has a Start call`);
    for (const l of lines) assert.ok(/guardedStart\(e\.currentTarget/.test(l) || /closePicker\(\); act\.startWorkout/.test(l), `${f}: unguarded start: ${l.trim()}`);
  }
});

test('views with recurring timers return a cleanup that stops them', () => {
  const t = read('js/ui/today-view.js');
  const tc = t.slice(t.lastIndexOf('return () => {'));
  assert.match(tc, /clearInterval\(clockTimer\)/);
  assert.match(tc, /clearTimeout\(midnightTimer\)/);
  const w = read('js/ui/workout-view.js');
  const wc = w.slice(w.lastIndexOf('return () => {'));
  assert.match(wc, /ticker\.stop\(\)/);
  assert.match(wc, /removeEventListener\('visibilitychange', onHidden\)/);
  assert.match(wc, /removeEventListener\('pagehide', persistAfterEdits\)/);
  for (const f of ['calendar-view', 'review-view', 'more-view', 'gym-view', 'exercise-view', 'history-view', 'library-view', 'routine-view', 'import-view']) {
    assert.equal(/setInterval\(|createTicker\(/.test(read(`js/ui/${f}.js`)), false, `${f}: a recurring timer needs a cleanup`);
  }
});

test('gym writes only go through enqueueGym; the import never writes habit_logs', () => {
  const files = [...listJs('js/ui'), ...listJs('js/lib'), ...listJs('js/data')];
  const GYM = ['exercises', 'routines', 'routine_items', 'schedule_slots', 'workouts', 'workout_exercises', 'sets'];
  for (const f of files) {
    const s = read(f);
    if (f !== 'js/data/gym-repo.js' && f !== 'js/data/repo.js' && f !== 'js/data/outbox.js') {
      assert.equal(/\boutbox\.enqueue\(/.test(s), false, `${f} enqueues directly`);
    }
    if (!f.startsWith('js/data/backend-') && f !== 'js/data/outbox.js') {
      assert.equal(/backend\.(upsert|insert|remove|delete)\(/.test(s), false, `${f} writes the backend directly`);
    }
  }
  const repo = read('js/data/repo.js');
  for (const t of GYM) assert.equal(repo.includes(`upsertOp('${t}'`), false, `repo.js writes ${t} around enqueueGym`);
  for (const f of ['js/lib/strive-import.js', 'js/ui/import-view.js', 'js/ui/import-model.js', 'tools/import-strive.mjs']) {
    assert.equal(read(f).includes('habit_logs'), false, `${f} mentions habit_logs`);
  }
});
