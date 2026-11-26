import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { ensureDefaults, loadSnapshot } from '../../js/data/repo.js';
import { ensureGymDefaults, needsGymSeed } from '../../js/data/gym-repo.js';
import { loadFirst } from '../../js/lib/boot-seed.js';
import { GYM_EXERCISES } from '../../js/data/gym-seed.js';
import { seedId } from '../../js/lib/ids.js';

const TODAY = '2026-11-24';
async function mkOutbox(backend) {
  const outbox = createOutbox({ backend, storage: createMemoryStorage() });
  await outbox.init();
  const ctx = { backend, outbox };
  return { ctx, outbox, load: () => loadSnapshot(ctx, TODAY) };
}
async function mk(seed = {}) {
  const backend = createMemoryBackend(seed);
  return { backend, ...(await mkOutbox(backend)) };
}
const boot = (m) => loadFirst({ ctx: m.ctx, load: m.load, ensureDefaults, ensureGymDefaults });
const rows = (b, t) => b.dump()[t] ?? [];

test('needsGymSeed: settings row present and gym_seeded_at null', () => {
  assert.equal(needsGymSeed({ settings: null }), false);
  assert.equal(needsGymSeed({ settings: { id: 1 } }), true);
  assert.equal(needsGymSeed({ settings: { gym_seeded_at: null } }), true);
  assert.equal(needsGymSeed({ settings: { gym_seeded_at: '2026-11-24T00:00:00Z' } }), false);
});

test('fresh boot seeds settings, 3 rituals, 72 exercises; second boot enqueues nothing', async () => {
  const m = await mk();
  const snap = await boot(m);
  assert.equal(rows(m.backend, 'settings').length, 1);
  assert.equal(rows(m.backend, 'rituals').length, 3);
  assert.equal(rows(m.backend, 'exercises').length, GYM_EXERCISES.length);
  assert.equal(GYM_EXERCISES.length, 72);
  assert.ok(snap.settings.gym_seeded_at);
  assert.equal(snap.exercises.length, 72);
  assert.ok(snap.exercises.every((e) => e.is_custom === false && e.archived === false));
  let enq = 0;
  const orig = m.outbox.enqueue;
  m.outbox.enqueue = (op) => { enq++; return orig(op); };
  await boot(m);
  assert.equal(enq, 0);
});

test('two devices seeding from the same snapshot produce exactly 72 exercises', async () => {
  const backend = createMemoryBackend();
  const a = await mkOutbox(backend);
  const b = await mkOutbox(backend);
  await ensureDefaults(a.ctx);
  await a.outbox.flush();
  const snap = await a.load();
  await ensureGymDefaults(a.ctx, snap);
  await ensureGymDefaults(b.ctx, snap);
  const ra = await a.outbox.flush();
  const rb = await b.outbox.flush();
  assert.deepEqual(ra.failed, []);
  assert.deepEqual(rb.failed, []);
  assert.equal(rows(backend, 'exercises').length, 72);
});

test('a deleted seeded exercise is not recreated', async () => {
  const m = await mk();
  await boot(m);
  await m.backend.remove('exercises', { eq: { name: 'Face Pull' } });
  const snap = await boot(m);
  assert.equal(snap.exercises.length, 71);
  assert.equal(rows(m.backend, 'exercises').length, 71);
});

test('an existing custom "bench press" leaves 71 seeded rows and no failure', async () => {
  const m = await mk();
  await ensureDefaults(m.ctx);
  await m.outbox.flush();
  await m.backend.upsert('exercises', [{ id: crypto.randomUUID(), name: 'bench press', muscle_group: 'chest', equipment: 'barbell', how_to: '', is_custom: true, archived: false }], { onConflict: 'id' });
  const snap = await m.load();
  await ensureGymDefaults(m.ctx, snap);
  const r = await m.outbox.flush();
  assert.deepEqual(r.failed, []);
  assert.equal(rows(m.backend, 'exercises').length, 72);
  assert.equal(rows(m.backend, 'exercises').filter((e) => e.is_custom === false).length, 71);
});

test('gym_habit_id: trimmed case-insensitive "gym" habit, else null', async () => {
  const hid = crypto.randomUUID();
  const m = await mk({ habits: [{ id: hid, name: ' GYM ', schedule_kind: 'daily', active: true, sort: 0 }] });
  await ensureDefaults(m.ctx);
  await m.outbox.flush();
  await ensureGymDefaults(m.ctx, await m.load());
  await m.outbox.flush();
  assert.equal(rows(m.backend, 'settings')[0].gym_habit_id, hid);
  const n = await mk();
  await ensureDefaults(n.ctx);
  await n.outbox.flush();
  await ensureGymDefaults(n.ctx, await n.load());
  await n.outbox.flush();
  assert.equal(rows(n.backend, 'settings')[0].gym_habit_id, null);
});

test('seed ids are deterministic per user', async () => {
  const m = await mk();
  const snap = await boot(m);
  const uid = snap.settings.user_id;
  const bench = snap.exercises.find((e) => e.name === 'Bench Press');
  assert.equal(bench.id, await seedId(uid, 'bench-press'));
});

test('app.js passes ensureGymDefaults to loadFirst', () => {
  assert.match(readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8'), /loadFirst\(\{[^}]*ensureGymDefaults/);
});
