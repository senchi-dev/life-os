// End-to-end gym boot, DOM-free: memory backend + memory outbox + memory kv, wired the way js/app.js wires them.
// loadFirst (both seeders) -> runtime init -> ensureIndex -> start next routine -> tick 3 sets -> finish -> snapshot;
// sign-out (outbox.clear + gym.clearAll) -> nothing left on the device; a second device on the same backend agrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { createMemoryKv } from '../../js/data/kv.js';
import { ensureDefaults, loadSnapshot } from '../../js/data/repo.js';
import { ensureGymDefaults } from '../../js/data/gym-repo.js';
import { GYM_EXERCISES } from '../../js/data/gym-seed.js';
import { loadFirst } from '../../js/lib/boot-seed.js';
import { createGymRuntime } from '../../js/lib/gym-runtime.js';
import { nextRoutineId, trainingCycle } from '../../js/lib/schedule.js';
import { seedId } from '../../js/lib/ids.js';

const TODAY = '2026-11-24';
const T0 = Date.parse('2026-11-24T10:00:00.000Z'); // 2026-11-24 in Europe/Paris and Pacific/Auckland
const USER = 'demo-user'; // createMemoryBackend's default user
const settle = () => new Promise((r) => setImmediate(r));

function mkClock(start = T0) {
  let t = start;
  return { now: () => new Date(t), advance(ms) { t += ms; } };
}
// Manual timers: the runtime's 250 ms draft save never fires on its own (flushDraft/finish write it).
function mkTimers() {
  let q = [];
  let id = 0;
  return { setTimer(fn, ms) { q.push({ id: ++id, fn, ms }); return id; }, clearTimer(i) { q = q.filter((x) => x.id !== i); } };
}
// Memory kv that can list its keys, so "kv empty" is a real check.
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

// A user who already has a Gym habit and two routines (A16), but no settings row yet: both seeders run at first boot.
async function mkBackend() {
  const ex = async (name) => seedId(USER, GYM_EXERCISES.find((e) => e.name === name).key);
  const upper = { id: crypto.randomUUID(), name: 'Upper', sort: 0, archived: false };
  const lower = { id: crypto.randomUUID(), name: 'Lower', sort: 1, archived: false };
  const item = async (r, name, position) => ({
    id: crypto.randomUUID(), routine_id: r.id, exercise_id: await ex(name), position, target_sets: 2, target_reps_min: 6, target_reps_max: 10,
  });
  const backend = createMemoryBackend({
    habits: [{ id: crypto.randomUUID(), name: 'Gym', schedule_kind: 'n_per_week', target_n: 3, weekdays: null, active: true, sort: 0 }],
    routines: [upper, lower],
    routine_items: [
      await item(upper, 'Bench Press', 0), await item(upper, 'Barbell Row', 1),
      await item(lower, 'Pull-up', 0),
    ],
  });
  return { backend, upper, lower };
}

// One device: its own outbox (and storage), kv, runtime, clock and timers; the backend is shared.
async function mkDevice(backend) {
  const outbox = createOutbox({ backend, storage: createMemoryStorage() });
  await outbox.init();
  const ctx = { backend, outbox };
  const kv = mkKv();
  const clock = mkClock();
  const timers = mkTimers();
  const dev = { ctx, outbox, kv, clock, snapshot: null };
  dev.load = () => loadSnapshot(ctx, TODAY);
  dev.gym = createGymRuntime({ ctx, kv, getSnapshot: () => dev.snapshot, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  // app.refresh(), first load of a session.
  dev.boot = async () => {
    dev.snapshot = await loadFirst({ ctx, load: dev.load, ensureDefaults, ensureGymDefaults });
    const g = await dev.gym.init();
    dev.gym.hideForgotten(dev.snapshot);
    await dev.gym.ensureIndex();
    return g;
  };
  return dev;
}

const next = (snap) => nextRoutineId({ cycle: trainingCycle(snap.scheduleSlots ?? [], snap.routines ?? []), workouts: snap.workouts ?? [] });

async function tick3(dev) {
  let n = 0;
  for (const e of dev.gym.draft().exercises) {
    for (const s of e.sets) {
      if (n === 3) return;
      for (const [field, value] of [['kg', 60 + n * 2.5], ['reps', 8]]) {
        const r = await dev.gym.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field, value });
        assert.equal(r.error, undefined, `edit ${field}`);
      }
      const r = await dev.gym.dispatch({ kind: 'tick', weId: e.id, setId: s.id });
      assert.equal(r.error, undefined, 'tick');
      dev.clock.advance(90000);
      n++;
    }
  }
  assert.equal(n, 3, 'the routine has at least 3 sets');
}

test('boot -> start next routine -> 3 sets -> finish -> sign-out -> second device sees the same history', async () => {
  const { backend, upper, lower } = await mkBackend();
  const a = await mkDevice(backend);

  // Boot: both seeders ran, the Gym habit is linked, nothing stale, an index exists.
  const init = await a.boot();
  assert.equal(init.stale, false);
  assert.equal(init.notice, null);
  assert.equal(a.snapshot.exercises.length, GYM_EXERCISES.length, 'library seeded');
  assert.ok(a.snapshot.settings.gym_seeded_at, 'gym seed stamped');
  const gymHabitId = a.snapshot.habits.find((h) => h.name === 'Gym').id;
  assert.equal(a.snapshot.settings.gym_habit_id, gymHabitId, 'Gym habit linked by the gym seeder');
  assert.equal(a.snapshot.rituals.length, 3, 'v1 defaults seeded');
  assert.ok(a.gym.index(), 'index built');
  assert.equal(a.outbox.pending(), 0);

  // Start the next routine (Upper: nothing finished yet), tick 3 sets, finish.
  assert.equal(next(a.snapshot), upper.id);
  const d = await a.gym.start(next(a.snapshot));
  assert.ok(d, 'draft created');
  assert.equal(d.workout.routine_id, upper.id);
  const day = d.workout.day;
  assert.equal(day, TODAY);
  await tick3(a);
  const end = a.clock.now().toISOString();
  const res = await a.gym.finish({ end, durationKnown: true, logUnticked: false });
  assert.equal(res.habitChecked, true);
  assert.equal(a.gym.draft(), null);
  await a.outbox.flush();
  assert.equal(a.outbox.pending(), 0, 'everything reached the backend');

  // The next snapshot (app.refresh) shows it.
  a.snapshot = await a.load();
  a.gym.hideForgotten(a.snapshot);
  await a.gym.ensureIndex();
  const w = a.snapshot.workouts.find((x) => x.id === d.workout.id);
  assert.ok(w, 'workout in the snapshot');
  assert.equal(w.ended_at, end, 'workout finished');
  assert.equal(a.snapshot.activeWorkout, null, 'no open workout');
  assert.ok(a.snapshot.habitLogs.some((l) => l.habit_id === gymHabitId && l.date === day && l.status === 'done'), 'Gym habit done on the day');
  assert.equal(next(a.snapshot), lower.id, 'next routine is the other one');
  const indexA = structuredClone(a.gym.index());
  assert.ok(indexA.workoutIds.includes(w.id), 'index has the workout');
  const mine = new Set((backend.dump().workout_exercises ?? []).filter((x) => x.workout_id === w.id).map((x) => x.id));
  assert.equal((backend.dump().sets ?? []).filter((s) => mine.has(s.workout_exercise_id)).length, 3, 'exactly 3 sets stored');

  // Sign-out with unsent work on the device: a queued op (backend down) and the saved index in kv.
  const realUpsert = backend.upsert;
  backend.upsert = async () => { throw new TypeError('Failed to fetch'); };
  await a.ctx.outbox.enqueue({ kind: 'upsert', table: 'habit_logs', rows: [{ habit_id: gymHabitId, date: '2026-11-23', status: 'done' }], onConflict: 'habit_id,date' });
  await a.outbox.flush().catch(() => {});
  assert.ok(a.outbox.pending() > 0, 'something is queued before sign-out');
  assert.ok(a.kv.keys().length > 0, 'gym state is stored before sign-out');
  // toLogin({ clear: true })
  await Promise.allSettled([a.outbox.clear(), a.gym.clearAll()]);
  backend.upsert = realUpsert;
  await settle();
  assert.deepEqual(a.kv.keys(), [], 'kv empty after sign-out');
  assert.equal(a.outbox.pending(), 0, 'queue empty after sign-out');
  assert.equal(a.gym.draft(), null);
  assert.equal(a.gym.index(), null);

  // A second device on the same backend: no active workout, the same history index.
  const b = await mkDevice(backend);
  const initB = await b.boot();
  assert.equal(initB.notice, null);
  assert.equal(b.gym.draft(), null, 'no draft on the second device');
  assert.equal(b.snapshot.activeWorkout, null, 'no active workout on the server');
  assert.equal(b.snapshot.exercises.length, GYM_EXERCISES.length, 'no second seed');
  assert.equal(next(b.snapshot), lower.id);
  assert.deepEqual(b.gym.index(), indexA, 'same index');
});
