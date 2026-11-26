// Integration tests for the gym runtime: memory backend + memory outbox + memory kv + fake clock and timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { createMemoryKv } from '../../js/data/kv.js';
import { demoSeed } from '../../js/data/demo-seed.js';
import { loadSnapshot } from '../../js/data/repo.js';
import { validateGymRow } from '../../js/lib/gym-validate.js';
import { createGymRuntime } from '../../js/lib/gym-runtime.js';

const TODAY = '2026-11-24';
const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const HOUR = 3600000;
const KEY = 'active-workout:demo-user';
const IDX = 'gym-index:demo-user';
const settle = () => new Promise((r) => setImmediate(r));

function mkClock(start = T0) {
  let t = start;
  return { now: () => new Date(t), advance(ms) { t += ms; }, set(v) { t = v; } };
}
function mkTimers() {
  let q = [];
  let id = 0;
  return {
    setTimer(fn, ms) { q.push({ id: ++id, fn, ms }); return id; },
    clearTimer(i) { q = q.filter((x) => x.id !== i); },
    get count() { return q.length; },
    get delays() { return q.map((x) => x.ms); },
    async fire() { const run = q; q = []; for (const x of run) await x.fn(); await settle(); },
  };
}
const counterId = () => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; };

// One "device": backend wrapper over a (possibly shared) memory db, outbox, kv, clock, timers.
async function mkEnv({ mem = createMemoryBackend(structuredClone(SEED)), kv = createMemoryKv(), clock = mkClock(), onAuthError = () => {} } = {}) {
  const state = { down: null };
  const calls = { select: [], kvSets: [] };
  const gate = () => {
    if (state.down === 'network') throw new TypeError('Failed to fetch');
    if (state.down === 'auth') throw Object.assign(new Error('JWT expired'), { status: 401 });
  };
  const backend = {
    async select(t, q) { calls.select.push({ t, q }); gate(); return mem.select(t, q); },
    async upsert(t, r, o) {
      gate();
      // Postgres enforces these foreign keys (23503 is a permanent rejection: the outbox drops the op).
      const parent = { workout_exercises: ['workouts', 'workout_id'], sets: ['workout_exercises', 'workout_exercise_id'] }[t];
      if (state.fk && parent) {
        const have = new Set((mem.dump()[parent[0]] ?? []).map((x) => x.id));
        if ((Array.isArray(r) ? r : [r]).some((x) => !have.has(x[parent[1]]))) throw Object.assign(new Error('violates foreign key'), { code: '23503' });
      }
      return mem.upsert(t, r, o);
    },
    async remove(t, q) { gate(); if (state.failRemove) throw new TypeError('Failed to fetch'); return mem.remove(t, q); },
    dump: () => mem.dump(),
  };
  const outbox = createOutbox({ backend, storage: createMemoryStorage(), onAuthError });
  await outbox.init();
  const enqueued = [];
  const origEnq = outbox.enqueue;
  outbox.enqueue = (op) => { enqueued.push(structuredClone(op)); return origEnq(op); };
  const ctx = { backend, outbox };
  const spyKv = {
    get: (k) => kv.get(k),
    async set(k, v) { calls.kvSets.push(k); return kv.set(k, v); },
    del: (k) => kv.del(k),
    delPrefix: (p) => kv.delPrefix(p),
  };
  const timers = mkTimers();
  let snap = await loadSnapshot(ctx, TODAY);
  const env = {
    mem, kv, spyKv, clock, timers, ctx, outbox, calls, enqueued, state,
    snap: () => snap,
    async reload() { const s = state.down; state.down = null; snap = await loadSnapshot(ctx, TODAY); state.down = s; },
    rt: (newId = counterId()) => createGymRuntime({ ctx, kv: spyKv, getSnapshot: () => snap, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, newId }),
    rows: (t) => mem.dump()[t] ?? [],
    setDown(v) { state.down = v; },
    upper: () => snap.routines.find((r) => r.name === 'Upper').id,
  };
  return env;
}
const SEED = demoSeed(TODAY);

// Ticks the first n sets of the draft (editing kg/reps first), one minute apart.
async function tickN(rt, clock, n) {
  let i = 0;
  for (const e of rt.draft().exercises) {
    for (const s of e.sets) {
      if (i >= n) return;
      await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'kg', value: 50 + i });
      await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'reps', value: 8 });
      const r = await rt.dispatch({ kind: 'tick', weId: e.id, setId: s.id });
      assert.equal(r.error, undefined);
      clock.advance(60000);
      i++;
    }
  }
}
const open = (env) => env.rows('workouts').filter((w) => w.ended_at == null);

test('init with nothing stored: no draft, no notice, not stale', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  assert.deepEqual(await rt.init(), { notice: null, stale: false });
  assert.equal(rt.draft(), null);
});

test('start(routine) creates one open workout on the backend and saves the draft immediately', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await env.outbox.flush();
  assert.equal(open(env).length, 1);
  assert.equal(open(env)[0].routine_id, env.upper());
  assert.equal(rt.draft().workout.id, open(env)[0].id);
  assert.equal((await env.kv.get(KEY)).workout.id, rt.draft().workout.id);
});

test('start twice quickly (overlapping) creates one workout', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await Promise.all([rt.start(env.upper()), rt.start(env.upper())]);
  await env.outbox.flush();
  assert.equal(open(env).length, 1);
  assert.equal(env.rows('workout_exercises').filter((x) => x.workout_id === open(env)[0].id).length, env.snap().routineItems.filter((i) => i.routine_id === env.upper()).length);
});

test('draft saves coalesce at 250 ms: nothing before the timer, one write at it, a new timer after', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await env.timers.fire(); // drop anything scheduled by start
  const before = env.calls.kvSets.filter((k) => k === KEY).length;
  const e = rt.draft().exercises[0];
  for (const [i, s] of e.sets.slice(0, 2).entries()) {
    await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'kg', value: 60 });
    await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'reps', value: 5 });
    await rt.dispatch({ kind: 'tick', weId: e.id, setId: s.id });
    assert.ok(i >= 0);
  }
  assert.equal(env.calls.kvSets.filter((k) => k === KEY).length, before, 'no write before the timer');
  assert.equal(env.timers.count, 1, 'one coalesced timer for all dispatches');
  assert.deepEqual(env.timers.delays, [250]);
  await env.timers.fire();
  assert.equal(env.calls.kvSets.filter((k) => k === KEY).length, before + 1, 'exactly one write after the timer');
  assert.equal((await env.kv.get(KEY)).exercises[0].sets.filter((s) => s.done).length, 2, 'the latest draft was saved');
  await rt.dispatch({ kind: 'edit', weId: e.id, setId: e.sets[2].id, field: 'kg', value: 61 });
  assert.equal(env.timers.count, 1, 'a dispatch after the timer schedules a new one');
  assert.equal(env.calls.kvSets.filter((k) => k === KEY).length, before + 1);
});

test('flushDraft writes immediately and cancels the pending timer', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await env.timers.fire();
  const e = rt.draft().exercises[0];
  await rt.dispatch({ kind: 'sessionNote', text: 'felt good' });
  assert.equal((await env.kv.get(KEY)).workout.note, '');
  await rt.flushDraft();
  assert.equal((await env.kv.get(KEY)).workout.note, 'felt good');
  assert.equal(env.timers.count, 0);
  assert.ok(e);
});

test('an error result neither enqueues nor schedules a save', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await env.timers.fire();
  const e = rt.draft().exercises[0];
  const n = env.enqueued.length;
  const r = await rt.dispatch({ kind: 'tick', weId: e.id, setId: e.sets[0].id }); // no kg/reps on a fresh routine
  assert.ok(r.error);
  assert.equal(env.enqueued.length, n);
  assert.equal(env.timers.count, 0);
  assert.equal(rt.draft().exercises[0].sets[0].done, false);
  assert.deepEqual(await rt.dispatch({ kind: 'tick', weId: 'nope', setId: 'nope' }), {});
});

test('dispatch without a draft reports an error instead of throwing', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  assert.ok((await rt.dispatch({ kind: 'sessionNote', text: 'x' })).error);
});

test('overlapping dispatches are serialised: every tick lands exactly once', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  const e = rt.draft().exercises[0];
  for (const s of e.sets) { await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'kg', value: 40 }); await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'reps', value: 8 }); }
  await Promise.all(e.sets.map((s) => rt.dispatch({ kind: 'tick', weId: e.id, setId: s.id })));
  await env.outbox.flush();
  assert.equal(rt.draft().exercises[0].sets.filter((s) => s.done).length, 3);
  assert.equal(env.rows('sets').filter((s) => e.sets.some((x) => x.id === s.id)).length, 3);
});

test('finish: workout ended, sets and habit log written, draft key removed, index updated with no backend select', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 3);
  const w = rt.draft().workout;
  const exId = rt.draft().exercises[0].exercise_id;
  const selects = env.calls.select.length;
  const end = env.clock.now().toISOString();
  const res = await rt.finish({ end, durationKnown: true, logUnticked: false });
  assert.equal(env.calls.select.length, selects, 'finish must not read the backend');
  assert.equal(res.habitChecked, true);
  assert.ok(Array.isArray(res.prLines));
  assert.equal(res.workoutRow.id, w.id);
  assert.equal(res.workoutRow.ended_at, end);
  assert.equal(res.habitLog.status, 'done');
  assert.equal(res.habitLog.date, w.day);
  await env.outbox.flush();
  const row = env.rows('workouts').find((x) => x.id === w.id);
  assert.equal(row.ended_at, end);
  assert.equal(env.rows('sets').filter((s) => rt && s.done_at && s.workout_exercise_id).length >= 3, true);
  const mine = new Set(env.rows('workout_exercises').filter((x) => x.workout_id === w.id).map((x) => x.id));
  assert.equal(env.rows('sets').filter((s) => mine.has(s.workout_exercise_id)).length, 3);
  assert.ok(env.rows('habit_logs').some((l) => l.habit_id === env.snap().settings.gym_habit_id && l.date === w.day && l.status === 'done'));
  assert.equal(await env.kv.get(KEY), undefined);
  assert.equal(rt.draft(), null);
  assert.equal(rt.index().exercises[exId].last.workoutId, w.id);
  assert.ok(rt.index().workoutIds.includes(w.id));
  assert.equal(env.timers.count, 0, 'no save timer survives finish');
  assert.ok((await env.kv.get(IDX)).workoutIds.includes(w.id), 'index persisted');
});

test('a late save timer cannot resurrect the draft after finish or discard', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 1);
  await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  await env.timers.fire();
  assert.equal(await env.kv.get(KEY), undefined);
});

test('finish never evaluates unticked sets for PRs; previewFinish is pure and agrees with finish', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  await rt.start(env.upper());
  const e = rt.draft().exercises[0];
  const [a, b] = e.sets;
  await rt.dispatch({ kind: 'edit', weId: e.id, setId: a.id, field: 'kg', value: 300 });
  await rt.dispatch({ kind: 'edit', weId: e.id, setId: a.id, field: 'reps', value: 5 });
  await rt.dispatch({ kind: 'tick', weId: e.id, setId: a.id });
  await rt.dispatch({ kind: 'edit', weId: e.id, setId: b.id, field: 'kg', value: 400 }); // unticked, heavier
  await rt.dispatch({ kind: 'edit', weId: e.id, setId: b.id, field: 'reps', value: 5 });
  const enq = env.enqueued.length;
  const selects = env.calls.select.length;
  const preview = rt.previewFinish();
  assert.equal(env.enqueued.length, enq, 'previewFinish writes nothing');
  assert.equal(env.calls.select.length, selects);
  assert.equal(preview.length, 1);
  assert.deepEqual(preview[0], { name: env.snap().exercises.find((x) => x.id === e.exercise_id).name, weight_kg: 300, reps: 5 });
  const res = await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  assert.deepEqual(res.prLines, preview);
});

test('logUnticked finishes the filled sets too, and every emitted gym row passes validateGymRow', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 2);
  const e = rt.draft().exercises[0];
  const extra = e.sets[2];
  await rt.dispatch({ kind: 'edit', weId: e.id, setId: extra.id, field: 'kg', value: 45 });
  await rt.dispatch({ kind: 'edit', weId: e.id, setId: extra.id, field: 'reps', value: 6 });
  const wid = rt.draft().workout.id;
  await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: true });
  await env.outbox.flush();
  const mine = new Set(env.rows('workout_exercises').filter((x) => x.workout_id === wid).map((x) => x.id));
  assert.equal(env.rows('sets').filter((s) => mine.has(s.workout_exercise_id)).length, 3);
  let checked = 0;
  for (const op of env.enqueued) {
    if (op.kind !== 'upsert') continue;
    for (const r of op.rows) { assert.equal(validateGymRow(op.table, r), null, `${op.table} ${JSON.stringify(r)}`); checked++; }
  }
  assert.ok(checked > 10);
});

test('discard removes the workout and reports whether the habit is still checked', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 1);
  const wid = rt.draft().workout.id;
  const r = await rt.discard();
  assert.equal(r.habitStillChecked, false);
  await env.outbox.flush();
  assert.equal(env.rows('workouts').some((w) => w.id === wid), false);
  assert.equal(env.rows('sets').length, SEED.sets.length);
  assert.equal(rt.draft(), null);
  assert.equal(await env.kv.get(KEY), undefined);
  // habit already done today (e.g. an earlier session): discarding does not uncheck it
  const habitId = env.snap().settings.gym_habit_id;
  env.snap().habitLogs.push({ habit_id: habitId, date: env.clock.now().toISOString().slice(0, 10), status: 'done' });
  await rt.start(env.upper());
  assert.equal((await rt.discard()).habitStillChecked, true);
});

test('start right after finishing ignores the stale snapshot that still shows the finished workout as open', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await env.outbox.flush();
  await env.reload(); // snapshot now has an active workout
  assert.ok(env.snap().activeWorkout);
  await tickN(rt, env.clock, 1);
  const first = rt.draft().workout.id;
  await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  await rt.start(env.upper());
  assert.ok(rt.draft());
  assert.notEqual(rt.draft().workout.id, first);
});

test('offline workout equals the online run row for row, queue holds every op, replay creates no duplicates', async () => {
  const run = async (offline) => {
    const env = await mkEnv();
    const rt = env.rt();
    await rt.init();
    await rt.ensureIndex(); // same prefill in both runs
    if (offline) env.setDown('network');
    await rt.start(env.upper());
    await tickN(rt, env.clock, 6);
    const end = env.clock.now().toISOString();
    await rt.finish({ end, durationKnown: true, logUnticked: false });
    await settle();
    if (offline) {
      assert.equal(env.outbox.pending(), env.enqueued.length, 'every op still queued');
      assert.ok(env.enqueued.length >= 8);
      assert.equal(rt.draft(), null);
      assert.equal(await env.kv.get(KEY), undefined);
      assert.ok(rt.index().workoutIds.length > 0 && rt.index().exercises);
      assert.equal(open(env).length, 0, 'backend untouched while offline');
      env.setDown(null);
    }
    await env.outbox.flush();
    assert.equal(env.outbox.pending(), 0);
    return env;
  };
  const strip = (rows) => rows.map(({ created_at, updated_at, ...r }) => r).sort((a, b) => (a.id < b.id ? -1 : 1));
  const on = await run(false);
  const off = await run(true);
  for (const t of ['workouts', 'workout_exercises', 'sets']) assert.deepEqual(strip(off.rows(t)), strip(on.rows(t)), t);
  const habit = (env) => env.rows('habit_logs').map((l) => `${l.habit_id}|${l.date}|${l.status}`).sort();
  assert.deepEqual(habit(off), habit(on));
  // replay every op a second time: same counts
  const counts = () => ['workouts', 'workout_exercises', 'sets', 'habit_logs'].map((t) => off.rows(t).length);
  const before = counts();
  for (const op of off.enqueued) {
    if (op.kind === 'remove') await off.ctx.backend.remove(op.table, { eq: op.eq });
    else await off.ctx.backend.upsert(op.table, op.rows, { onConflict: op.onConflict, ignoreDuplicates: op.ignoreDuplicates });
  }
  assert.deepEqual(counts(), before);
});

test('expired session: ops kept, onAuthError once, draft intact in kv', async () => {
  let authCalls = 0;
  const env = await mkEnv({ onAuthError: () => { authCalls++; } });
  const rt = env.rt();
  await rt.init();
  env.setDown('auth');
  await rt.start(env.upper());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(authCalls, 1);
  assert.equal(env.outbox.pending(), env.enqueued.length);
  assert.ok(env.outbox.pending() > 0);
  await rt.flushDraft();
  assert.equal((await env.kv.get(KEY)).workout.id, rt.draft().workout.id);
  assert.equal(open(env).length, 0);
});

test('second device: start mirrors the server workout (ticked sets only) and creates nothing', async () => {
  const a = await mkEnv();
  const rtA = a.rt();
  await rtA.init();
  await rtA.start(a.upper());
  await tickN(rtA, a.clock, 2);
  await a.outbox.flush();
  const b = await mkEnv({ mem: a.mem });
  assert.ok(b.snap().activeWorkout);
  const rtB = b.rt();
  await rtB.init();
  const rowsBefore = JSON.stringify(a.mem.dump());
  await rtB.start(b.upper());
  await b.outbox.flush();
  assert.equal(b.enqueued.length, 0);
  assert.equal(JSON.stringify(a.mem.dump()), rowsBefore);
  assert.equal(rtB.draft().workout.id, rtA.draft().workout.id);
  const sets = rtB.draft().exercises.flatMap((e) => e.sets);
  assert.equal(sets.length, 2);
  assert.ok(sets.every((s) => s.done));
});

test('init reconciles a stored draft: finished elsewhere -> dropped with a notice', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await env.outbox.flush();
  await rt.flushDraft();
  const w = open(env)[0];
  await env.mem.upsert('workouts', [{ ...w, ended_at: new Date(T0 + HOUR).toISOString() }], { onConflict: 'id' });
  await env.reload();
  const rt2 = env.rt();
  const r = await rt2.init();
  assert.equal(rt2.draft(), null);
  assert.match(r.notice, /finished/i);
  assert.equal(await env.kv.get(KEY), undefined);
});

test('init reconciles a stored draft: absent on the server with an empty queue -> dropped; with pending ops -> kept', async () => {
  const mk = async (offline) => {
    const env = await mkEnv();
    const rt = env.rt();
    await rt.init();
    if (offline) env.setDown('network');
    await rt.start(env.upper());
    await settle();
    if (!offline) { await env.outbox.flush(); await env.mem.remove('workouts', { eq: { id: rt.draft().workout.id } }); }
    await rt.flushDraft();
    await env.reload();
    return env;
  };
  const gone = await mk(false);
  const rt1 = gone.rt();
  const r1 = await rt1.init();
  assert.equal(rt1.draft(), null);
  assert.ok(r1.notice);
  assert.equal(await gone.kv.get(KEY), undefined);
  const pend = await mk(true);
  assert.ok(pend.outbox.pending() > 0);
  const rt2 = pend.rt();
  const r2 = await rt2.init();
  assert.ok(rt2.draft());
  assert.equal(r2.notice, null);
  assert.ok(await pend.kv.get(KEY));
});

test('stale: more than 6 h since the last activity blocks, exactly 6 h and 5 h do not', async () => {
  const stale = async (gap) => {
    const env = await mkEnv();
    const rt = env.rt();
    await rt.init();
    await rt.start(env.upper());
    await tickN(rt, env.clock, 1); // last tick at T0, clock now T0 + 1 min
    await rt.flushDraft();
    const lastTick = rt.draft().lastTickAt;
    env.clock.set(Date.parse(lastTick) + gap);
    await env.outbox.flush();
    await env.reload(); // the open workout is on the server, so reconcile keeps the draft
    return env.rt().init();
  };
  assert.equal((await stale(7 * HOUR)).stale, true);
  assert.equal((await stale(6 * HOUR + 1)).stale, true);
  assert.equal((await stale(6 * HOUR)).stale, false);
  assert.equal((await stale(5 * HOUR)).stale, false);
});

test('clearAll removes only the two gym prefixes and the in-memory state', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.start(env.upper());
  await rt.ensureIndex();
  await env.kv.set('other:x', 1);
  await env.kv.set('active-workout:someone-else', 2);
  await rt.clearAll();
  assert.equal(await env.kv.get(KEY), undefined);
  assert.equal(await env.kv.get(IDX), undefined);
  assert.equal(await env.kv.get('other:x'), 1);
  assert.equal(await env.kv.get('active-workout:someone-else'), undefined);
  assert.equal(rt.draft(), null);
  assert.equal(rt.index(), null);
});

const historyReads = (env) => env.calls.select.filter((c) => c.t === 'workouts' && !c.q.in && c.q.range).length;

test('ensureIndex builds once (concurrent calls share it); a later finished workout fetches only its own id', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await Promise.all([rt.ensureIndex(), rt.ensureIndex()]);
  const first = historyReads(env);
  assert.ok(first >= 1);
  await rt.ensureIndex();
  assert.equal(historyReads(env), first, 'second call does not refetch history');
  assert.ok((await env.kv.get(IDX)).workoutIds.length >= 6);
  // another device finishes a workout
  const ex = env.snap().exercises[0].id;
  const day = '2026-11-23';
  await env.mem.upsert('workouts', [{ id: 'w-new', routine_id: null, name: 'Upper', day, started_at: '2026-11-23T18:00:00.000Z', ended_at: '2026-11-23T19:00:00.000Z', duration_known: true, note: '', imported: false, source_ref: null }], { onConflict: 'id' });
  await env.mem.upsert('workout_exercises', [{ id: 'we-new', workout_id: 'w-new', exercise_id: ex, position: 0, note: '' }], { onConflict: 'id' });
  await env.mem.upsert('sets', [{ id: 's-new', workout_exercise_id: 'we-new', set_no: 1, reps: 5, weight_kg: 100, type: 'normal', is_pr: false, done_at: '2026-11-23T18:10:00.000Z' }], { onConflict: 'id' });
  await env.reload();
  env.calls.select.length = 0;
  await rt.ensureIndex();
  assert.equal(historyReads(env), 0);
  const byId = env.calls.select.filter((c) => c.t === 'workouts' && c.q.in && c.q.in.id);
  assert.equal(byId.length, 1);
  assert.deepEqual(byId[0].q.in.id, ['w-new']);
  assert.ok(rt.index().workoutIds.includes('w-new'));
  assert.equal(rt.index().exercises[ex].last.workoutId, 'w-new');
});

test('ensureIndex reuses the index saved in kv on a new runtime (no history fetch)', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  env.calls.select.length = 0;
  const rt2 = env.rt();
  await rt2.init();
  await rt2.ensureIndex();
  assert.equal(historyReads(env), 0);
  assert.ok(rt2.index().workoutIds.length >= 6);
});

test('a workout finished locally while the index is still being fetched is not lost', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 1);
  // force a full rebuild to be in flight while finishing
  let release;
  const gateP = new Promise((r) => { release = r; });
  const origSelect = env.ctx.backend.select;
  env.ctx.backend.select = async (t, q) => { await gateP; return origSelect(t, q); };
  env.ctx.backend.upsert = () => new Promise(() => {}); // the server never sees the finished workout during the fetch
  const rebuilding = rt.rebuildIndex();
  const wid = rt.draft().workout.id;
  await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  release();
  await rebuilding;
  assert.ok(rt.index().workoutIds.includes(wid));
});

test('finish: a rejected enqueue leaves draft, kv draft and index untouched; a retry succeeds once', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 3);
  await rt.flushDraft();
  const before = structuredClone(rt.draft());
  const indexBefore = structuredClone(rt.index());
  const queued = env.enqueued.length;
  const real = env.outbox.enqueue;
  env.outbox.enqueue = async () => { throw new Error('storage full'); };
  const end = env.clock.now().toISOString();
  await assert.rejects(() => rt.finish({ end, durationKnown: true, logUnticked: false }), /storage full/);
  assert.deepEqual(rt.draft(), before);
  assert.deepEqual(rt.index(), indexBefore);
  assert.ok(await env.kv.get(KEY), 'the stored draft survives a failed finish');
  assert.equal(env.enqueued.length, queued, 'nothing was committed to the queue');
  env.outbox.enqueue = real;
  const res = await rt.finish({ end, durationKnown: true, logUnticked: false });
  assert.equal(res.workoutRow.ended_at, end);
  assert.equal(rt.draft(), null);
  assert.ok(rt.index().workoutIds.includes(before.workout.id));
});

test('finish twice: the second call rejects with no-draft and enqueues nothing', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 2);
  const end = env.clock.now().toISOString();
  await rt.finish({ end, durationKnown: true, logUnticked: false });
  const n = env.enqueued.length;
  const pending = env.outbox.pending();
  await assert.rejects(() => rt.finish({ end, durationKnown: true, logUnticked: false }), /no-draft/);
  assert.equal(env.enqueued.length, n);
  assert.equal(env.outbox.pending(), pending);
});

import { enqueueGym, removeRow } from '../../js/data/gym-repo.js';

const del = async (env, rt, id) => { await enqueueGym(env.ctx, [removeRow('workouts', id)]); rt.forgetWorkout(id); };
// Indexed workouts that are inside the snapshot window, newest first. Index order follows random uuids and the demo seed
// has a workout older than the 42-day snapshot window, so `workoutIds[0]` would be a random (sometimes unsnapshotted) pick.
const recentIds = (env, rt) => {
  const started = new Map(env.snap().workouts.map((w) => [w.id, w.started_at]));
  return rt.index().workoutIds.filter((id) => started.has(id)).sort((a, b) => (started.get(a) < started.get(b) ? 1 : -1));
};
const inIndex = (rt, id) => rt.index().workoutIds.includes(id) || Object.values(rt.index().exercises).some((e) => e.sessions.some((x) => x.workoutId === id));

test('forgetWorkout: drops the sessions now and a no-index runtime ignores it', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  const [wid] = recentIds(env, rt);
  const n = rt.index().workoutIds.length;
  rt.forgetWorkout(wid);
  assert.equal(rt.index().workoutIds.length, n - 1);
  assert.ok(!inIndex(rt, wid));
  rt.forgetWorkout('does-not-exist'); // harmless
  const cold = env.rt();
  cold.forgetWorkout('x');
  assert.equal(cold.index(), null);
});

test('delete while the remove is still queued: ensureIndex and the snapshot do NOT resurrect the workout', async () => {
  const env = await mkEnv();
  env.state.failRemove = true; // the server is reachable for reads, the queued remove cannot be sent
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  const [wid] = recentIds(env, rt);
  await del(env, rt, wid);
  assert.equal(env.outbox.pending(), 1);
  env.calls.select.length = 0;
  await rt.ensureIndex();
  assert.ok(env.calls.select.length > 0, 'a rebuild ran from the server, which still has the workout');
  assert.ok(!inIndex(rt, wid), 'tombstone filters the rebuild');
  assert.equal(rt.isForgotten(wid), true);
  await env.reload();
  assert.ok(env.snap().workouts.some((w) => w.id === wid), 'the raw server snapshot still has it');
  assert.ok(!rt.hideForgotten(env.snap()).workouts.some((w) => w.id === wid), 'snapshot reload is filtered');
  // the server finally accepts the remove: tombstone clears, server and index agree
  env.state.failRemove = false;
  await env.outbox.flush();
  assert.equal(env.outbox.pending(), 0);
  await rt.ensureIndex();
  assert.equal(rt.isForgotten(wid), false);
  assert.ok(!env.rows('workouts').some((w) => w.id === wid));
  assert.ok(!inIndex(rt, wid));
});

test('a failed flush keeps the tombstone; two deletes are both hidden then both cleared', async () => {
  const env = await mkEnv();
  env.state.failRemove = true;
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  const [a, b] = recentIds(env, rt);
  await del(env, rt, a);
  await del(env, rt, b);
  await env.outbox.flush().catch(() => {});
  assert.deepEqual([...rt.forgottenIds()].sort(), [a, b].sort());
  await rt.ensureIndex();
  assert.ok(!inIndex(rt, a) && !inIndex(rt, b));
  env.state.failRemove = false;
  await env.outbox.flush();
  await rt.ensureIndex();
  assert.deepEqual([...rt.forgottenIds()], []);
  assert.ok(!env.rows('workouts').some((w) => w.id === a || w.id === b));
});

test('the tombstone survives a reload (kv) while the remove is still queued', async () => {
  const env = await mkEnv();
  env.state.failRemove = true;
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  const [wid] = recentIds(env, rt);
  await del(env, rt, wid);
  await rt.flushDraft();
  const rt2 = env.rt();
  await rt2.init();
  assert.equal(rt2.isForgotten(wid), true);
  await rt2.ensureIndex();
  assert.ok(!inIndex(rt2, wid));
});

test('deleting a workout that never reached the server works (finished offline, then deleted)', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  env.setDown('network');
  await rt.start(env.upper());
  await tickN(rt, env.clock, 2);
  const wid = rt.draft().workout.id;
  await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  assert.ok(inIndex(rt, wid));
  await del(env, rt, wid);
  assert.ok(!inIndex(rt, wid));
  env.setDown(null);
  await env.outbox.flush();
  assert.ok(!env.rows('workouts').some((w) => w.id === wid), 'upsert then remove, in order');
  await rt.ensureIndex();
  assert.ok(!inIndex(rt, wid));
  assert.equal(rt.isForgotten(wid), false);
});

test('while the index is stale (rebuild flagged) a finish applies nothing incrementally, gives no PR lines, and keeps the flag', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  rt.forgetWorkout(recentIds(env, rt)[0]); // flags the rebuild
  await rt.start(env.upper());
  await tickN(rt, env.clock, 3);
  assert.deepEqual(rt.previewFinish(), [], 'no PR lines from a stale baseline');
  const wid = rt.draft().workout.id;
  const r = await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  assert.deepEqual(r.prLines, []);
  assert.ok(!rt.index().workoutIds.includes(wid), 'not folded into the stale index');
  env.calls.select.length = 0;
  await rt.ensureIndex();
  assert.ok(env.calls.select.length > 0, 'flag stayed set: the next ensureIndex rebuilds');
  assert.ok(rt.index().workoutIds.includes(wid), 'and the rebuilt index has the finished workout');
});

// ---- C1: a workout closed OFFLINE must never come back as a live draft --------------------------------------------
const CLOSED = 'gym-index:closed:demo-user';

// Start online (the open workout reaches the server), tick, then lose the network and close it: the close op stays queued.
async function closedOffline(how) {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  await rt.start(env.upper());
  await tickN(rt, env.clock, 2);
  await env.outbox.flush();
  const wid = rt.draft().workout.id;
  env.setDown('network');
  if (how === 'finish') await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  else await rt.discard();
  await env.outbox.flush().catch(() => {});
  assert.ok(env.outbox.pending() > 0, 'the close op is still queued');
  await settle();
  // Reopen: the snapshot (read before the capped flush landed the op) still shows the workout open.
  await env.reload();
  assert.equal(env.snap().activeWorkout?.workout.id, wid, 'the raw snapshot still shows it open');
  return { env, wid };
}

for (const how of ['finish', 'discard']) {
  test(`C1 ${how} offline -> reopen with a stale snapshot: no draft, Start creates a NEW workout`, async () => {
    const { env, wid } = await closedOffline(how);
    assert.ok(Array.isArray(await env.kv.get(CLOSED)), 'closed ids are persisted');
    const rt2 = env.rt(() => crypto.randomUUID()); // a fresh id source (the counter would reuse the first runtime's ids)
    const r = await rt2.init();
    assert.equal(rt2.draft(), null, 'the closed workout is not rebuilt as a draft');
    assert.equal(r.notice, null);
    assert.equal(rt2.isClosed(wid), true);
    assert.equal(env.snap().activeWorkout, null, 'init hides the closed workout from the snapshot');
    const w = env.snap().workouts.find((x) => x.id === wid);
    if (how === 'finish') assert.ok(w && w.ended_at, 'the finished row is shown finished');
    else assert.equal(w, undefined, 'the discarded row is hidden');
    const d = await rt2.start(env.upper());
    assert.ok(d);
    assert.notEqual(d.workout.id, wid, 'a new workout, not a resume of the closed one');
    // a later snapshot reload (still queued) is filtered the same way
    await env.reload();
    rt2.hideForgotten(env.snap());
    assert.notEqual(env.snap().activeWorkout?.workout.id, wid);
  });

  test(`C1 ${how}: the closed set survives a failed flush and clears once the queue drained and the server agrees`, async () => {
    const { env, wid } = await closedOffline(how);
    const rt2 = env.rt();
    await rt2.init();
    rt2.hideForgotten(env.snap());
    assert.equal(rt2.isClosed(wid), true, 'kept while the op is queued');
    env.setDown(null);
    await env.outbox.flush();
    assert.equal(env.outbox.pending(), 0);
    await env.reload();
    rt2.hideForgotten(env.snap());
    await settle();
    assert.equal(rt2.isClosed(wid), false, 'cleared after the drain');
    assert.equal(await env.kv.get(CLOSED), undefined, 'and removed from kv');
    const w = env.rows('workouts').find((x) => x.id === wid);
    if (how === 'finish') assert.ok(w.ended_at); else assert.equal(w, undefined);
  });
}

test('C1: a snapshot read before the drain is still filtered even if the queue is empty by the time it is applied', async () => {
  const { env, wid } = await closedOffline('finish');
  const rt2 = env.rt();
  await rt2.init();
  await env.reload();
  const stale = structuredClone(env.snap()); // raw server read taken while the finish was still queued: shows it open
  assert.equal(stale.activeWorkout?.workout.id, wid);
  env.setDown(null);
  await env.outbox.flush();
  assert.equal(env.outbox.pending(), 0, 'the queue drained after that read');
  rt2.hideForgotten(stale);
  assert.equal(stale.activeWorkout, null, 'the stale snapshot is filtered');
  assert.equal(rt2.isClosed(wid), true, 'and the id is not cleared on the strength of a stale snapshot');
});

test('C1: clearAll removes the closed key; a different user never inherits it', async () => {
  const { env, wid } = await closedOffline('finish');
  // another user on this device (same kv): their snapshot shows a workout with the same id open
  const other = structuredClone(env.snap());
  other.settings = { ...other.settings, user_id: 'someone-else' };
  const rtOther = createGymRuntime({ ctx: env.ctx, kv: env.spyKv, getSnapshot: () => other, now: env.clock.now, setTimer: env.timers.setTimer, clearTimer: env.timers.clearTimer });
  await rtOther.init();
  assert.equal(rtOther.isClosed(wid), false);
  assert.equal(rtOther.draft()?.workout.id, wid, 'not hidden for a user who never closed it');
  const rt2 = env.rt();
  await rt2.init();
  assert.ok(await env.kv.get(CLOSED));
  await rt2.clearAll();
  assert.equal(await env.kv.get(CLOSED), undefined);
  assert.equal(rt2.isClosed(wid), false);
});

test('I2: done sets whose tick upserts were lost (outbox cleared) still reach the backend at finish', async () => {
  const env = await mkEnv();
  const rt = env.rt();
  await rt.init();
  await rt.ensureIndex();
  await rt.start(env.upper());
  await env.outbox.flush(); // the workout and its exercises are on the server
  env.setDown('network');
  // light sets (never a PR against the seeded history): before I2 only PR sets were re-sent at finish
  let n = 0;
  for (const e of rt.draft().exercises) for (const s of e.sets) {
    if (n === 3) break;
    await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'kg', value: 1 });
    await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'reps', value: 1 });
    assert.equal((await rt.dispatch({ kind: 'tick', weId: e.id, setId: s.id })).error, undefined);
    env.clock.advance(60000);
    n++;
  }
  assert.deepEqual(rt.previewFinish(), [], 'no PR among them');
  assert.ok(env.outbox.pending() > 0);
  await env.outbox.clear(); // e.g. recheckSession dropped the queue but the draft survived
  env.setDown(null);
  const done = rt.draft().exercises.flatMap((e) => e.sets.filter((s) => s.done).map((s) => s.id));
  assert.equal(done.length, 3);
  await rt.finish({ end: env.clock.now().toISOString(), durationKnown: true, logUnticked: false });
  await env.outbox.flush();
  assert.equal(env.outbox.pending(), 0);
  const stored = new Set(env.rows('sets').map((s) => s.id));
  for (const id of done) assert.ok(stored.has(id), `set ${id} reached the backend`);
  for (const op of env.enqueued) if (op.kind === 'upsert') for (const row of op.rows) assert.equal(validateGymRow(op.table, row), null);
});

// ---- Follow-up 2: finish re-sends the parents (workout, workout_exercises) before the sets ---------------------------
for (const lost of ['workout_exercises', 'workout']) {
  test(`finish after the queue lost the ${lost} insert: every done set still reaches an FK-enforcing backend`, async () => {
    const env = await mkEnv();
    env.state.fk = true;
    const rt = env.rt();
    await rt.init();
    await rt.ensureIndex();
    env.setDown('network');
    await rt.start(env.upper());
    if (lost === 'workout_exercises') {
      env.setDown(null);
      // the workout row lands, the exercises op is lost
      const [first] = env.enqueued.filter((o) => o.table === 'workouts');
      await env.mem.upsert('workouts', first.rows, { onConflict: 'id' });
      env.setDown('network');
    }
    let n = 0;
    for (const e of rt.draft().exercises) for (const s of e.sets) {
      if (n === 3) break;
      await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'kg', value: 1 });
      await rt.dispatch({ kind: 'edit', weId: e.id, setId: s.id, field: 'reps', value: 1 });
      await rt.dispatch({ kind: 'tick', weId: e.id, setId: s.id });
      env.clock.advance(60000);
      n++;
    }
    await env.outbox.clear(); // the queue (start insert + ticks) is lost; the draft survives
    assert.equal(env.rows('workout_exercises').filter((x) => x.workout_id === rt.draft().workout.id).length, 0);
    const wid = rt.draft().workout.id;
    const done = rt.draft().exercises.flatMap((e) => e.sets.filter((s) => s.done).map((s) => s.id));
    env.setDown(null);
    const end = env.clock.now().toISOString();
    await rt.finish({ end, durationKnown: true, logUnticked: false });
    await env.outbox.flush();
    assert.equal(env.outbox.pending(), 0);
    const stored = new Set(env.rows('sets').map((x) => x.id));
    for (const id of done) assert.ok(stored.has(id), `set ${id} stored`);
    assert.equal(env.rows('workouts').find((w) => w.id === wid).ended_at, end, 'the last workouts write is the finished row');
  });
}

// ---- Follow-up 3: the closed-id sweep runs only on LIVE snapshots ---------------------------------------------------
test('a cached snapshot never clears a closed id, even with the queue empty; the next live one does', async () => {
  const { env, wid } = await closedOffline('finish');
  const rt2 = env.rt();
  await rt2.init();
  env.setDown(null);
  await env.outbox.flush();
  assert.equal(env.outbox.pending(), 0);
  // an offline copy saved before the workout existed: it does not show it open, but it proves nothing
  const cachedCopy = structuredClone(env.snap());
  cachedCopy.activeWorkout = null;
  cachedCopy.workouts = cachedCopy.workouts.filter((w) => w.id !== wid);
  rt2.hideForgotten(cachedCopy, { cached: true });
  await settle();
  assert.equal(rt2.isClosed(wid), true, 'kept after a cached snapshot');
  assert.ok(await env.kv.get(CLOSED));
  await env.reload();
  rt2.hideForgotten(env.snap());
  await settle();
  assert.equal(rt2.isClosed(wid), false, 'cleared by the live snapshot');
});
