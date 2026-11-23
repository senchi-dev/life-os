import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { ensureDefaults, loadSnapshot, addWater } from '../../js/data/repo.js';
import { localDateKey } from '../../js/lib/dates.js';
import { needsSeed, flushCapped, loadFirst, createResume } from '../../js/lib/boot-seed.js';

const TODAY = localDateKey(new Date());
async function mk(seed = {}, storage = createMemoryStorage()) {
  const backend = createMemoryBackend(seed);
  const outbox = createOutbox({ backend, storage });
  await outbox.init();
  const ctx = { backend, outbox };
  const load = () => loadSnapshot(ctx, TODAY);
  return { ctx, backend, outbox, storage, load };
}
const boot = (m, extra = {}) => loadFirst({ ctx: m.ctx, load: m.load, ensureDefaults, ...extra });
const rows = (b, t) => b.dump()[t] ?? [];

test('needsSeed keys on a NULL settings row only', () => {
  assert.equal(needsSeed({ settings: null, rituals: [{}] }), true);
  assert.equal(needsSeed({ settings: { id: 1 }, rituals: [] }), false);
  assert.equal(needsSeed(null), false);
});

test('B1: first boot on an empty backend seeds 3 rituals and 1 settings row', async () => {
  const m = await mk();
  const snap = await boot(m);
  assert.equal(rows(m.backend, 'settings').length, 1);
  assert.equal(rows(m.backend, 'rituals').length, 3);
  assert.equal(snap.rituals.length, 3);
  assert.notEqual(snap.settings, null);
});

test('B1: booting twice does not duplicate', async () => {
  const m = await mk();
  await boot(m); await boot(m);
  assert.equal(rows(m.backend, 'settings').length, 1);
  assert.equal(rows(m.backend, 'rituals').length, 3);
});

test('B1: settings present but rituals empty is NOT re-seeded', async () => {
  const m = await mk({ settings: [{ id: 's', user_id: 'demo-user', water_target_l: 2, weekly_pages: 100 }] });
  const snap = await boot(m);
  assert.equal(snap.rituals.length, 0);
  assert.equal(rows(m.backend, 'rituals').length, 0);
});

test('B1: a failing reload after seeding falls back to the first snapshot', async () => {
  const m = await mk();
  let n = 0;
  const load = async () => { if (++n === 2) throw new Error('boom'); return m.load(); };
  const snap = await loadFirst({ ctx: m.ctx, load, ensureDefaults });
  assert.equal(snap.settings, null);
});

test('B2: a queued op is applied before the first load and present in the snapshot', async () => {
  const storage = createMemoryStorage();
  const first = await mk({}, storage);
  const row = addWater(first.ctx, 0.5, new Date()); // queued; backend of "first" is thrown away (app closed)
  await new Promise((r) => setTimeout(r, 5));
  // cold start: new outbox over the persisted queue, a different (server) backend
  const server = createMemoryBackend({ settings: [{ id: 's', user_id: 'demo-user' }] });
  const outbox = createOutbox({ backend: server, storage });
  await outbox.init();
  // the first outbox may already have flushed into its own backend; re-queue deterministically
  await storage.save([{ id: 'op1', kind: 'upsert', table: 'water', rows: { id: row.id, liters: 0.5, at: new Date().toISOString() }, onConflict: 'id' }]);
  await outbox.init();
  const ctx = { backend: server, outbox };
  const snap = await loadFirst({ ctx, load: () => loadSnapshot(ctx, TODAY), ensureDefaults });
  assert.equal(snap.water.length, 1);
  assert.equal(outbox.pending(), 0);
});

function fakeTimers() {
  const t = { fn: null };
  return { t, setTimer: (fn) => { t.fn = fn; return 1; }, clearTimer: () => {} };
}
const tick = () => new Promise((r) => setImmediate(r));

test('B2: a hanging flush does not block the first load beyond the cap', async () => {
  const { t, setTimer, clearTimer } = fakeTimers();
  let release; let loads = 0; let late = 0;
  const outbox = { flush: () => new Promise((res) => { release = res; }) };
  const p = loadFirst({
    ctx: { outbox }, load: async () => { loads++; return { settings: {} }; }, ensureDefaults: async () => {},
    capMs: 3000, setTimer, clearTimer, onLate: () => { late++; },
  });
  await tick();
  assert.equal(loads, 0, 'waits for the flush until the cap');
  t.fn();
  const snap = await p;
  assert.equal(loads, 1);
  assert.deepEqual(snap, { settings: {} });
  release({ sent: 2 });
  await tick();
  assert.equal(late, 1, 'late flush that sent something triggers a refresh');
});

test('B2: flushCapped reports sent and survives a rejecting flush', async () => {
  const { setTimer, clearTimer } = fakeTimers();
  assert.equal(await flushCapped({ flush: async () => ({ sent: 3 }) }, { setTimer, clearTimer }), 3);
  assert.equal(await flushCapped({ flush: async () => { throw new Error('x'); } }, { setTimer, clearTimer }), 0);
});

test('R5: online/resume retry the first load and re-check a deferred session', async () => {
  const calls = [];
  const state = { mode: 'app', snapshot: null, deferred: false };
  const r = createResume({
    getMode: () => state.mode, hasSnapshot: () => !!state.snapshot, isSessionDeferred: () => state.deferred,
    flush: async () => { calls.push('flush'); }, refresh: async () => { calls.push('refresh'); },
    recheckSession: async () => { calls.push('recheck'); },
  });
  await r.online();
  assert.deepEqual(calls, ['flush', 'refresh']);
  calls.length = 0;
  await r.visible();
  assert.deepEqual(calls, ['refresh'], 'resume retries only while there is no snapshot');
  state.snapshot = {};
  calls.length = 0;
  await r.visible();
  assert.deepEqual(calls, []);
  state.mode = 'login'; state.deferred = true;
  await r.online();
  assert.deepEqual(calls, ['recheck']);
  calls.length = 0;
  state.deferred = false;
  await r.online();
  assert.deepEqual(calls, []);
});

test('R5: online never rejects even if flush or refresh throw', async () => {
  const r = createResume({
    getMode: () => 'app', hasSnapshot: () => false, isSessionDeferred: () => false,
    flush: async () => { throw new Error('f'); }, refresh: async () => { throw new Error('r'); }, recheckSession: async () => {},
  });
  await r.online(); await r.visible();
});
