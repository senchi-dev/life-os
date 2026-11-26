// I1: reopening the app with NO signal. The last good snapshot is cached per user in kv (IndexedDB in the browser, like
// the outbox); a first load that fails on the network boots from it, so the gym runtime can restore the draft and the
// user keeps logging offline. Sign-out deletes it. Memory backend + memory outbox + memory kv, wired like js/app.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { createMemoryKv } from '../../js/data/kv.js';
import { demoSeed } from '../../js/data/demo-seed.js';
import { loadSnapshot } from '../../js/data/repo.js';
import { createGymRuntime } from '../../js/lib/gym-runtime.js';
import {
  SNAPSHOT_CACHE_PREFIX, snapshotCacheKey, saveSnapshotCache, readSnapshotCache, clearSnapshotCache, loadFirstOrCached, refreshSnapshot,
} from '../../js/lib/snapshot-cache.js';
import { loadFirst } from '../../js/lib/boot-seed.js';
import { setHabitStatus, addWater } from '../../js/data/repo.js';

const TODAY = '2026-11-24';
const USER = 'demo-user';
const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const settle = () => new Promise((r) => setImmediate(r));
const authErr = () => Object.assign(new Error('JWT expired'), { kind: 'auth' });
const isAuthError = (e) => e?.kind === 'auth';

function mkKv() {
  const kv = createMemoryKv();
  const keys = new Set();
  return {
    get: (k) => kv.get(k),
    async set(k, v) { keys.add(k); return kv.set(k, v); },
    async del(k) { keys.delete(k); return kv.del(k); },
    async delPrefix(p) { for (const k of [...keys]) if (k.startsWith(p)) keys.delete(k); return kv.delPrefix(p); },
    keys: () => [...keys],
  };
}

// The network can be cut: every backend call then throws like fetch does offline.
function mkNet(mem) {
  const net = { down: false };
  const gate = () => { if (net.down) throw new TypeError('Failed to fetch'); };
  net.backend = {
    async select(t, q) { gate(); return mem.select(t, q); },
    async upsert(t, r, o) { gate(); return mem.upsert(t, r, o); },
    async remove(t, q) { gate(); return mem.remove(t, q); },
    dump: () => mem.dump(),
  };
  return net;
}

// One app session on the device: a fresh outbox over the persisted queue storage, a fresh runtime over the persisted kv.
async function mkSession({ net, storage, kv }) {
  const outbox = createOutbox({ backend: net.backend, storage });
  await outbox.init();
  const ctx = { backend: net.backend, outbox };
  let t = T0;
  const s = { ctx, outbox, snapshot: null, fromCache: false };
  s.gym = createGymRuntime({ ctx, kv, getSnapshot: () => s.snapshot, now: () => new Date(t), setTimer: () => 0, clearTimer: () => {} });
  s.advance = (ms) => { t += ms; };
  // app.refresh(), first load: fall back to the cache only on a non-auth failure.
  s.boot = async (uid = USER) => {
    const r = await loadFirstOrCached({ load: () => loadSnapshot(ctx, TODAY), kv, uid, isAuthError });
    s.snapshot = r.snapshot;
    s.fromCache = r.fromCache;
    const g = await s.gym.init({ cached: s.fromCache });
    s.gym.hideForgotten(s.snapshot);
    return g;
  };
  return s;
}

test('first load succeeds: the snapshot is cached under the user key', async () => {
  const mem = createMemoryBackend(demoSeed(TODAY));
  const net = mkNet(mem);
  const kv = mkKv();
  const a = await mkSession({ net, storage: createMemoryStorage(), kv });
  await a.boot();
  assert.equal(a.fromCache, false);
  await settle();
  const cached = await readSnapshotCache(kv, USER);
  assert.ok(cached, 'cache written');
  assert.deepEqual(cached.workouts.map((w) => w.id), a.snapshot.workouts.map((w) => w.id));
  assert.ok(kv.keys().includes(snapshotCacheKey(USER)));
});

test('reopen with no signal: boots from the cache, the draft is restored, ticks queue offline; sign-out clears the cache', async () => {
  const mem = createMemoryBackend(demoSeed(TODAY));
  const net = mkNet(mem);
  const kv = mkKv();
  const storage = createMemoryStorage();

  // Session 1 (online): start a workout, tick one set, everything synced; the app is then closed.
  const a = await mkSession({ net, storage, kv });
  await a.boot();
  const upper = a.snapshot.routines.find((r) => r.name === 'Upper').id;
  await a.gym.start(upper);
  const e = a.gym.draft().exercises[0];
  await a.gym.dispatch({ kind: 'edit', weId: e.id, setId: e.sets[0].id, field: 'kg', value: 60 });
  await a.gym.dispatch({ kind: 'tick', weId: e.id, setId: e.sets[0].id });
  await a.gym.flushDraft();
  await a.outbox.flush();
  assert.equal(a.outbox.pending(), 0);
  const wid = a.gym.draft().workout.id;

  // Session 2: no signal at all.
  net.down = true;
  const b = await mkSession({ net, storage, kv });
  const g = await b.boot();
  assert.equal(b.fromCache, true, 'the snapshot came from the cache');
  assert.ok(b.snapshot.routines.length > 0, 'the app has data to render');
  assert.equal(g.notice, null);
  assert.equal(b.gym.draft()?.workout.id, wid, 'the workout in progress is back');
  assert.equal(b.gym.draft().exercises[0].sets[0].done, true);
  b.advance(60000);
  const s2 = b.gym.draft().exercises[0].sets[1];
  assert.deepEqual(await b.gym.dispatch({ kind: 'edit', weId: e.id, setId: s2.id, field: 'kg', value: 62.5 }), {});
  assert.deepEqual(await b.gym.dispatch({ kind: 'tick', weId: e.id, setId: s2.id }), {});
  assert.ok(b.outbox.pending() > 0, 'the ticks are queued');
  await b.outbox.flush().catch(() => {});
  assert.ok(b.outbox.pending() > 0, 'still queued while offline');

  // Signal back: a later refresh succeeds and replaces the cache; the queued tick reached the server.
  net.down = false;
  await b.outbox.flush();
  assert.equal(b.outbox.pending(), 0);
  assert.ok(mem.dump().sets.some((x) => x.id === s2.id), 'the offline tick reached the backend');
  const fresh = await loadFirstOrCached({ load: () => loadSnapshot(b.ctx, TODAY), kv, uid: USER, isAuthError });
  assert.equal(fresh.fromCache, false);
  b.snapshot = fresh.snapshot; // the first live snapshot: init runs again and reconciles against it
  assert.equal((await b.gym.init()).notice, null);
  assert.equal(b.gym.draft()?.workout.id, wid, 'the draft is kept (the workout is open on the server)');
  await settle();
  const cached = await readSnapshotCache(kv, USER);
  assert.ok(cached.activeWorkout.sets.some((x) => x.id === s2.id), 'cache replaced by the newer snapshot');

  // Sign-out (toLogin clear branch): outbox, gym state and the cache all go.
  await Promise.allSettled([b.outbox.clear(), b.gym.clearAll(), clearSnapshotCache(kv)]);
  assert.equal(await readSnapshotCache(kv, USER), null);
  assert.deepEqual(kv.keys().filter((k) => k.startsWith(SNAPSHOT_CACHE_PREFIX)), []);
});

test('an offline boot from a cache older than the draft never closes the draft (the live re-init does reconcile)', async () => {
  const mem = createMemoryBackend(demoSeed(TODAY));
  const net = mkNet(mem);
  const kv = mkKv();
  const storage = createMemoryStorage();
  const a = await mkSession({ net, storage, kv });
  await a.boot(); // cache written now: no workout in it
  await a.gym.start(a.snapshot.routines[0].id);
  await a.gym.flushDraft();
  await a.outbox.flush();
  const wid = a.gym.draft().workout.id;
  // finished on another device meanwhile
  await mem.upsert('workouts', [{ ...mem.dump().workouts.find((w) => w.id === wid), ended_at: new Date(T0 + 3600e3).toISOString() }], { onConflict: 'id' });
  net.down = true;
  const b = await mkSession({ net, storage, kv });
  await b.boot();
  assert.equal(b.fromCache, true);
  assert.equal(b.gym.draft()?.workout.id, wid, 'kept: a cached snapshot proves nothing');
  net.down = false;
  b.snapshot = await loadSnapshot(b.ctx, TODAY);
  const g = await b.gym.init();
  assert.equal(b.gym.draft(), null, 'the live snapshot closes it');
  assert.match(g.notice, /finished on another device/);
});

test('no cache, an auth error, or another user\'s cache: the first-load error is rethrown', async () => {
  const kv = mkKv();
  const netErr = new TypeError('Failed to fetch');
  await assert.rejects(() => loadFirstOrCached({ load: async () => { throw netErr; }, kv, uid: USER, isAuthError }), (e) => e === netErr);
  await saveSnapshotCache(kv, USER, { settings: { user_id: USER }, workouts: [] });
  const a = authErr();
  await assert.rejects(() => loadFirstOrCached({ load: async () => { throw a; }, kv, uid: USER, isAuthError }), (e) => e === a);
  await assert.rejects(() => loadFirstOrCached({ load: async () => { throw netErr; }, kv, uid: 'someone-else', isAuthError }), (e) => e === netErr);
  await assert.rejects(() => loadFirstOrCached({ load: async () => { throw netErr; }, kv, uid: null, isAuthError }), (e) => e === netErr);
  const ok = await loadFirstOrCached({ load: async () => { throw netErr; }, kv, uid: USER, isAuthError });
  assert.equal(ok.fromCache, true);
});

test('a cache row whose user_id does not match its key is ignored; a snapshot without settings is not cached', async () => {
  const kv = mkKv();
  await kv.set(snapshotCacheKey(USER), { v: 1, snapshot: { settings: { user_id: 'x' } } });
  assert.equal(await readSnapshotCache(kv, USER), null);
  await saveSnapshotCache(kv, USER, { settings: null });
  assert.equal(await readSnapshotCache(kv, USER), null);
});

test('a save that finishes after sign-out is undone (stillValid false)', async () => {
  const kv = mkKv();
  let valid = true;
  const p = saveSnapshotCache(kv, USER, { settings: { user_id: USER } }, { stillValid: () => valid });
  valid = false;
  await p;
  assert.equal(await readSnapshotCache(kv, USER), null);
});

test('the cached copy is a snapshot of the moment: later in-memory edits do not leak into it', async () => {
  const kv = mkKv();
  const snap = { settings: { user_id: USER }, workouts: [{ id: 'a' }] };
  const p = saveSnapshotCache(kv, USER, snap);
  snap.workouts.push({ id: 'b' });
  await p;
  assert.deepEqual((await readSnapshotCache(kv, USER)).workouts, [{ id: 'a' }]);
});

// Wiring: app.js boots from the cache and clears it on sign-out.
const src = readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');
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

test('wiring: toLogin clears the snapshot cache inside the clear branch, with the outbox and gym state', () => {
  const b = body('async toLogin');
  const branch = b.slice(b.indexOf('if (clear)'));
  assert.match(branch.slice(0, 400), /clearSnapshotCache\(kv\)/);
  assert.match(branch.slice(0, 400), /outbox\.clear\(\)/);
});

test('wiring: refresh falls back to the cache on the first load and saves good snapshots', () => {
  const b = body('async refresh');
  assert.match(b, /refreshSnapshot\(\{/); // loadFirstOrCached (first load) and saveSnapshotCache (live) live in it
  assert.match(b, /\.gym\.init\(/);
});

// ---- Follow-up 1: offline edits survive failed refreshes while running from the cache ----------------------------
// The app-side contract (app.refresh): a refresh that throws keeps app.snapshot; one that returns replaces it.
async function appRefresh(app) {
  try {
    const r = await refreshSnapshot({
      current: app.snapshot, currentCached: app.cached,
      loadFirst: () => loadFirst({ ctx: app.ctx, load: () => loadSnapshot(app.ctx, TODAY), ensureDefaults: async () => {}, capMs: 1000 }),
      loadLive: () => loadSnapshot(app.ctx, TODAY),
      kv: app.kv, uid: USER, isAuthError,
    });
    app.snapshot = r.snapshot;
    app.cached = r.fromCache;
    return 'replaced';
  } catch {
    return 'kept';
  }
}

test('running from the cache: failed refreshes keep the offline edits in memory; a live refresh replaces them with server data', async () => {
  const seed = demoSeed(TODAY);
  const mem = createMemoryBackend(seed);
  const net = mkNet(mem);
  const kv = mkKv();
  const storage = createMemoryStorage();
  const a = await mkSession({ net, storage, kv });
  await a.boot(); // cache written

  net.down = true;
  const outbox = createOutbox({ backend: net.backend, storage });
  await outbox.init();
  const app = { ctx: { backend: net.backend, outbox }, kv, snapshot: null, cached: false };
  assert.equal(await appRefresh(app), 'replaced');
  assert.equal(app.cached, true, 'booted from the cache');

  // Offline edits, applied optimistically to the in-memory snapshot (as the views do) and queued.
  const habit = app.snapshot.habits.find((h) => h.name !== 'Gym') ?? app.snapshot.habits[0];
  await setHabitStatus(app.ctx, habit.id, TODAY, 'done');
  app.snapshot.habitLogs = [...app.snapshot.habitLogs.filter((l) => !(l.habit_id === habit.id && l.date === TODAY)), { id: 'local', habit_id: habit.id, date: TODAY, status: 'done' }];
  const { row } = addWater(app.ctx, 0.5, new Date(T0));
  app.snapshot.water = [...app.snapshot.water, row];
  assert.ok(outbox.pending() >= 2);

  // Unlock (resume.visible), the online event and Retry all refresh; still no signal.
  for (let i = 0; i < 3; i++) assert.equal(await appRefresh(app), 'kept');
  assert.ok(app.snapshot.habitLogs.some((l) => l.habit_id === habit.id && l.date === TODAY && l.status === 'done'), 'habit edit kept');
  assert.ok(app.snapshot.water.some((w) => w.id === row.id), 'water edit kept');
  assert.equal(app.cached, true);

  // Signal back: the first-load path flushes the queue, then the server data replaces the snapshot.
  net.down = false;
  assert.equal(await appRefresh(app), 'replaced');
  assert.equal(app.cached, false);
  assert.equal(outbox.pending(), 0, 'queued ops flushed');
  assert.ok(app.snapshot.water.some((w) => w.id === row.id), 'server data has the water entry');
  assert.ok(app.snapshot.habitLogs.some((l) => l.habit_id === habit.id && l.date === TODAY && l.status === 'done' && l.id !== 'local'), 'server row for the habit');
  assert.ok((await readSnapshotCache(kv, USER)).water.some((w) => w.id === row.id), 'the cache now holds the live data');
  assert.equal(await appRefresh(app), 'replaced', 'a live refresh (loadLive path) succeeds');
  // Later, a live snapshot in memory and a failed load: kept too (never swapped for the older cache).
  net.down = true;
  const before = app.snapshot;
  assert.equal(await appRefresh(app), 'kept');
  assert.equal(app.snapshot, before);
});

test('refreshSnapshot: no snapshot yet and offline -> the cache; no snapshot and no cache -> throws', async () => {
  const kv = mkKv();
  const fail = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => refreshSnapshot({ current: null, currentCached: false, loadFirst: fail, loadLive: fail, kv, uid: USER, isAuthError }));
  await saveSnapshotCache(kv, USER, { settings: { user_id: USER }, workouts: [] });
  const r = await refreshSnapshot({ current: null, currentCached: false, loadFirst: fail, loadLive: fail, kv, uid: USER, isAuthError });
  assert.equal(r.fromCache, true);
  let reads = 0;
  const spy = { ...kv, get: (k) => { reads++; return kv.get(k); } };
  await assert.rejects(() => refreshSnapshot({ current: r.snapshot, currentCached: true, loadFirst: fail, loadLive: fail, kv: spy, uid: USER, isAuthError }));
  assert.equal(reads, 0, 'the cache is not re-read while a snapshot is in memory');
});

test('wiring: refresh goes through refreshSnapshot and passes cached to hideForgotten', () => {
  const b = body('async refresh');
  assert.match(b, /refreshSnapshot\(\{/);
  assert.match(b, /current: app\.snapshot, currentCached: app\.snapshotCached/);
  assert.match(b, /hideForgotten\(app\.snapshot, \{ cached \}\)/);
});
