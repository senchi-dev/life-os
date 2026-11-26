// Integration tests for the in-app Strive import: memory backend + outbox + gym runtime, synthetic fixture only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { createMemoryKv } from '../../js/data/kv.js';
import { demoSeed } from '../../js/data/demo-seed.js';
import { loadSnapshot } from '../../js/data/repo.js';
import { createGymRuntime } from '../../js/lib/gym-runtime.js';
import { runImportFlow } from '../../js/ui/import-view.js';
import { NOT_STRIVE, INCOMPLETE, NOT_READY, GENERIC_ERROR, TOO_BIG, MAX_FILE_BYTES } from '../../js/ui/import-model.js';
import { mkJson, extraSession } from './fixtures/strive-json.mjs';

const TODAY = '2026-11-24';

// The demo seed carries one imported workout (demo:1); a first import starts without it.
function cleanSeed() {
  const s = demoSeed(TODAY);
  const drop = new Set(s.workouts.filter((w) => w.imported).map((w) => w.id));
  const we = new Set(s.workout_exercises.filter((e) => drop.has(e.workout_id)).map((e) => e.id));
  s.workouts = s.workouts.filter((w) => !drop.has(w.id));
  s.workout_exercises = s.workout_exercises.filter((e) => !drop.has(e.workout_id));
  s.sets = s.sets.filter((x) => !we.has(x.workout_exercise_id));
  return s;
}
async function mkEnv({ seed = cleanSeed(), storage = createMemoryStorage(), mem = createMemoryBackend(structuredClone(seed)) } = {}) {
  const st = { down: null, failTable: null, failAfter: null, calls: 0, dropAfterOps: null };
  const backend = {
    async select(t, q) {
      if (st.down === 'network' || st.selectDown) throw new TypeError('Failed to fetch');
      return mem.select(t, q);
    },
    async upsert(t, r, o) {
      if (st.down === 'network') throw new TypeError('Failed to fetch');
      if (st.down === 'auth') throw Object.assign(new Error('JWT expired'), { status: 401 });
      const reject = () => Object.assign(new Error('violates check constraint'), { status: 400, code: '23514' });
      if (st.failTable === t) throw reject();
      st.hook?.(t);
      if (st.swallow) return undefined; // a backend that says yes and stores nothing
      if (st.partial && st.partial.table === t) { await mem.upsert(t, r.slice(0, st.partial.keep), o); throw reject(); }
      st.calls++;
      if (st.cutAfter != null && st.calls > st.cutAfter) throw new TypeError('Failed to fetch');
      return mem.upsert(t, r, o);
    },
    async remove(t, q) { if (st.failRemove) throw new TypeError('Failed to fetch'); return mem.remove(t, q); },
    dump: () => mem.dump(),
  };
  let authErrors = 0;
  const outbox = createOutbox({ backend, storage, onAuthError: () => { authErrors++; } });
  await outbox.init();
  const ctx = { backend, outbox };
  let snap = await loadSnapshot(ctx, TODAY);
  const gym = createGymRuntime({ ctx, kv: createMemoryKv(), getSnapshot: () => snap });
  const refreshes = [];
  const env = {
    mem, st, ctx, outbox, gym, storage, refreshes,
    authErrors: () => authErrors,
    snap: () => snap,
    reload: async () => { snap = await loadSnapshot(ctx, TODAY); return snap; },
    rows: (t) => mem.dump()[t] ?? [],
    flow: (opts = {}) => runImportFlow({
      ctx, gym, snapshot: snap, refresh: async () => { refreshes.push(1); await env.reload(); }, file: 'file' in opts ? opts.file : fileOf(JSON.stringify(mkJson())), includeDuplicates: opts.includeDuplicates,
    }),
  };
  return env;
}
const fileOf = (text) => ({ text: async () => text, size: text.length });
const imported = (env) => env.rows('workouts').filter((w) => w.imported);

test('preview: exact line for the synthetic export, mapping names only, no ids', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  assert.equal(r.stage, 'preview');
  const p = r.preview;
  assert.equal(p.sessions, 3); assert.equal(p.newSessions, 3); assert.equal(p.alreadyImported, 0);
  assert.ok(r.line.startsWith('3 sessions · 8 exercise entries · 18 sets · 2 routines · '));
  assert.ok(r.line.endsWith(' · 1 how-to note · 1 session note · 0 already imported · 0 possible duplicates'));
  assert.ok(p.mapping.length > 0);
  for (const m of p.mapping) assert.deepEqual(Object.keys(m).sort(), ['kind', 'lifeos', 'renamed', 'strive']);
});

test('commit: backend counts equal the JSON counts, index rebuilt, refresh called, queue drained', async () => {
  const env = await mkEnv();
  const json = mkJson();
  const before = { w: env.rows('workouts').length, we: env.rows('workout_exercises').length, s: env.rows('sets').length };
  const r = await env.flow();
  const res = await r.commit();
  assert.equal(res.status, 'done');
  assert.ok(res.queued > 0);
  assert.equal(env.outbox.pending(), 0);
  assert.equal(imported(env).length, json.counts.sessions);
  assert.equal(env.rows('workouts').length - before.w, json.counts.sessions);
  assert.equal(env.rows('workout_exercises').length - before.we, json.counts.entries);
  assert.equal(env.rows('sets').length - before.s, json.counts.sets);
  assert.equal(env.refreshes.length, 1);
  for (const w of imported(env)) assert.ok(env.gym.index().workoutIds.includes(w.id), 'index has the imported sessions');
  assert.ok(Object.keys(env.gym.index().exercises).length > 0);
});

test('second run: nothing new, no ops, no duplicate rows, commit touches nothing', async () => {
  const env = await mkEnv();
  await (await env.flow()).commit();
  await env.reload();
  const counts = () => ['workouts', 'workout_exercises', 'sets', 'exercises', 'routines', 'routine_items'].map((t) => env.rows(t).length);
  const before = counts();
  const r2 = await env.flow();
  assert.equal(r2.preview.newSessions, 0);
  assert.equal(r2.preview.alreadyImported, 3);
  assert.equal(r2.ops.length, 0);
  const res = await r2.commit();
  assert.equal(res.queued, 0);
  assert.equal(env.outbox.pending(), 0);
  assert.deepEqual(counts(), before);
});

test('a plan with newSessions 0 never enqueues, even when other ops exist', async () => {
  const env = await mkEnv();
  await (await env.flow()).commit();
  await env.reload();
  const r2 = await env.flow();
  r2.ops.push({ kind: 'upsert', table: 'exercises', rows: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Sneaky', muscle_group: 'core', equipment: 'other', how_to: '', is_custom: false, archived: false }], onConflict: 'id' });
  const res = await r2.commit();
  assert.equal(res.queued, 0);
  assert.equal(env.rows('exercises').some((e) => e.name === 'Sneaky'), false);
});

test('double tap: two commits at once enqueue once and share the result; a third after it too', async () => {
  const env = await mkEnv();
  const enq = [];
  const orig = env.outbox.enqueue;
  env.outbox.enqueue = (op) => { enq.push(op); return orig(op); };
  const r = await env.flow();
  const [a, b] = await Promise.all([r.commit(), r.commit()]);
  assert.equal(a, b);
  const n = enq.length;
  assert.ok(n > 0 && n === a.queued);
  const c = await r.commit();
  assert.equal(c, a);
  assert.equal(enq.length, n);
  assert.equal(env.refreshes.length, 1);
});

test('offline commit: ops persisted in storage, no throw, returns queued, nothing rebuilt', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  env.st.down = 'network';
  const res = await r.commit();
  assert.equal(res.status, 'offline');
  assert.equal(res.queued, r.ops.length);
  assert.equal(env.outbox.pending(), r.ops.length);
  assert.equal((await env.storage.load()).length, r.ops.length);
  assert.equal(imported(env).length, 0);
  assert.equal(env.refreshes.length, 0);
  // back online: the persisted queue completes the import
  env.st.down = null;
  await env.outbox.flush();
  assert.equal(imported(env).length, 3);
});

test('partial failure (non-network rejection) is reported honestly, not as success', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  const base = env.rows('sets').length;
  env.st.failTable = 'sets';
  const res = await r.commit();
  assert.equal(res.status, 'partial');
  assert.deepEqual([res.applied, res.total], [0, 3], 'sessions without their sets are not imported sessions');
  assert.equal(res.message, 'Imported 0 of 3 sessions; some items failed — try again, the import is safe to repeat.');
  assert.equal(env.refreshes.length, 1, 'rows landed, so the screen is refreshed');
  assert.equal(env.rows('sets').length, base, 'no import sets landed');
  // try again: the plan sees the workouts without children and repairs them
  env.st.failTable = null;
  await env.reload();
  const r2 = await env.flow();
  assert.equal(r2.preview.newSessions, 0);
  assert.equal(r2.preview.repaired, 3);
  const res2 = await r2.commit();
  assert.equal(res2.status, 'done');
  assert.equal(env.rows('sets').length, base + 18);
  const r3 = await env.flow();
  assert.equal(r3.ops.length, 0);
});

test('mid-flush cut (network) then re-run through the flow completes with no duplicates', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  env.st.cutAfter = 4; // first four ops apply, then the connection drops
  const res = await r.commit();
  assert.equal(res.status, 'offline');
  // The queue still holds the rest; drop it as if the app was reinstalled, then re-run the import from the file.
  await env.outbox.clear();
  env.st.cutAfter = null;
  await env.reload();
  const r2 = await env.flow();
  const res2 = await r2.commit();
  assert.equal(res2.status, 'done');
  assert.equal(imported(env).length, 3);
  assert.equal(env.rows('workout_exercises').filter((e) => imported(env).some((w) => w.id === e.workout_id)).length, 8);
  const ids = env.rows('sets').map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((await env.flow()).ops.length, 0);
});

test('every prefix cut of the op list converges through the UI flow (no duplicates, complete)', async () => {
  const probe = await mkEnv();
  const n = (await probe.flow()).ops.length;
  for (let cut = 0; cut <= n; cut++) {
    const env = await mkEnv();
    const r = await env.flow();
    env.st.cutAfter = cut;
    await r.commit();
    await env.outbox.clear();
    env.st.cutAfter = null;
    await env.reload();
    const r2 = await env.flow();
    if (r2.ops.length) assert.equal((await r2.commit()).status, 'done', `cut ${cut}`);
    await env.reload();
    assert.equal(imported(env).length, 3, `cut ${cut}`);
    assert.equal((await env.flow()).ops.length, 0, `cut ${cut}`);
    const ids = env.rows('sets').map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `cut ${cut}`);
  }
});

test('auth error mid-import: reported as auth, queue kept, outbox onAuthError path fired once', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  env.st.down = 'auth';
  const res = await r.commit();
  assert.equal(res.status, 'auth');
  assert.equal(env.outbox.pending(), r.ops.length);
  for (let i = 0; i < 5 && !env.authErrors(); i++) await new Promise((resolve) => setTimeout(resolve, 0)); // onAuthError is deferred one macrotask
  assert.equal(env.authErrors(), 1);
  assert.equal(env.refreshes.length, 0);
});

test('rebuildIndex failure after a successful flush does not turn the import into a failure', async () => {
  const env = await mkEnv();
  env.gym.rebuildIndex = async () => { throw new Error('index boom'); };
  const r = await env.flow();
  const res = await r.commit();
  assert.equal(res.status, 'done');
  assert.equal(imported(env).length, 3);
  assert.equal(env.refreshes.length, 1);
});

test('refresh failure after a successful flush does not turn the import into a failure', async () => {
  const env = await mkEnv();
  const r = await runImportFlow({ ctx: env.ctx, gym: env.gym, snapshot: env.snap(), refresh: async () => { throw new Error('boom'); }, file: fileOf(JSON.stringify(mkJson())) });
  const res = await r.commit();
  assert.equal(res.status, 'done');
});

test('garbage and wrong-format files give the exact message and touch nothing', async () => {
  const env = await mkEnv();
  const bad = [
    'not json at all', '', '   \n', 'null', '[]', '5', '"str"', 'true', '{}',
    JSON.stringify({ ...mkJson(), format: 'lifeos-strive-2' }), JSON.stringify({ ...mkJson(), format: undefined }),
    JSON.stringify([mkJson()]),
  ];
  for (const t of bad) {
    const r = await env.flow({ file: fileOf(t) });
    assert.equal(r.stage, 'error', JSON.stringify(t));
    assert.equal(r.message, NOT_STRIVE, JSON.stringify(t));
  }
  assert.equal(env.outbox.pending(), 0);
});

test('a UTF-8 BOM at the start is tolerated', async () => {
  const env = await mkEnv();
  const r = await env.flow({ file: fileOf(`﻿${JSON.stringify(mkJson())}`) });
  assert.equal(r.stage, 'preview');
});

test('structurally broken but correctly labelled files get a message, never an exception', async () => {
  const env = await mkEnv();
  const j = mkJson();
  for (const bad of [{ ...j, workouts: 'x' }, { ...j, workouts: [{}] }, { ...j, exercises: null }, { ...j, routines: undefined }, { ...j, counts: null }, { ...j, workouts: [{ ...j.workouts[0], exercises: null }] }]) {
    const r = await env.flow({ file: fileOf(JSON.stringify(bad)) });
    assert.equal(r.stage, 'error');
    assert.ok([NOT_STRIVE, INCOMPLETE, GENERIC_ERROR].includes(r.message), r.message);
  }
});

test('count mismatch: exact message, one off in each field', async () => {
  const env = await mkEnv();
  const j = mkJson();
  for (const k of ['sessions', 'entries', 'sets']) {
    const r = await env.flow({ file: fileOf(JSON.stringify({ ...j, counts: { ...j.counts, [k]: j.counts[k] + 1 } })) });
    assert.equal(r.message, INCOMPLETE);
  }
});

test('library not seeded: exact message, and unseeded snapshot is checked even for a good file', async () => {
  const env = await mkEnv();
  for (const settings of [{ ...env.snap().settings, gym_seeded_at: null }, { ...env.snap().settings, gym_seeded_at: undefined }]) {
    const r = await runImportFlow({ ctx: env.ctx, gym: env.gym, snapshot: { ...env.snap(), settings }, refresh: async () => {}, file: fileOf(JSON.stringify(mkJson())) });
    assert.deepEqual([r.stage, r.message], ['error', NOT_READY]);
  }
  const none = await runImportFlow({ ctx: env.ctx, gym: env.gym, snapshot: { ...env.snap(), settings: null }, refresh: async () => {}, file: fileOf(JSON.stringify(mkJson())) });
  assert.equal(none.message, NOT_READY);
});

test('huge file: 20 MB passes the guard, 20 MB + 1 is refused before reading it', async () => {
  const env = await mkEnv();
  let read = 0;
  const big = { size: MAX_FILE_BYTES + 1, text: async () => { read++; return '{}'; } };
  const r = await env.flow({ file: big });
  assert.deepEqual([r.stage, r.message, read], ['error', TOO_BIG, 0]);
  const edge = { size: MAX_FILE_BYTES, text: async () => { read++; return '{}'; } };
  const r2 = await env.flow({ file: edge });
  assert.equal(read, 1);
  assert.equal(r2.message, NOT_STRIVE);
  // no size property: the text length is checked after reading
  const r3 = await env.flow({ file: { text: async () => 'x'.repeat(MAX_FILE_BYTES + 1) } });
  assert.equal(r3.message, TOO_BIG);
});

test('unreadable file and missing file give messages', async () => {
  const env = await mkEnv();
  assert.equal((await env.flow({ file: { text: async () => { throw new Error('io'); } } })).stage, 'error');
  assert.equal((await env.flow({ file: null })).stage, 'error');
});

test('a valid export with 0 sessions is an error, not an empty import', async () => {
  const env = await mkEnv();
  const j = { ...mkJson(), workouts: [], counts: { sessions: 0, entries: 0, sets: 0 } };
  const r = await env.flow({ file: fileOf(JSON.stringify(j)) });
  assert.equal(r.stage, 'error');
  assert.match(r.message, /no sessions/i);
});

test('over-long notes: 2000 chars pass, 2001 gives a message naming the item without echoing the text', async () => {
  const env = await mkEnv();
  const j = mkJson();
  const mk = (len) => ({ ...j, workouts: j.workouts.map((w, i) => (i === 0 ? { ...w, note: 'S'.repeat(len) } : w)) });
  assert.equal((await env.flow({ file: fileOf(JSON.stringify(mk(2000))) })).stage, 'preview');
  const r = await env.flow({ file: fileOf(JSON.stringify(mk(2001))) });
  assert.equal(r.stage, 'error');
  assert.ok(r.message.includes(j.workouts[0].name));
  assert.ok(!r.message.includes('SSSS'));
  const how = { ...j, exercises: j.exercises.map((e, i) => (i === 0 ? { ...e, how_to: 'H'.repeat(2001) } : e)) };
  const r2 = await env.flow({ file: fileOf(JSON.stringify(how)) });
  assert.ok(r2.message.includes(j.exercises[0].name_en));
  assert.ok(!r2.message.includes('HHHH'));
});

test('unsupported unit / set type in the file: validator rejection becomes a message at preview, nothing queued', async () => {
  const env = await mkEnv();
  const j = mkJson();
  const bad = structuredClone(j);
  bad.workouts[0].exercises[0].sets[0].type = 'weird';
  const r = await env.flow({ file: fileOf(JSON.stringify(bad)) });
  assert.equal(r.stage, 'error');
  assert.match(r.message, /cannot be imported/);
  assert.match(r.message, /\(sets\)/);
  assert.equal(env.outbox.pending(), 0);
});

test('a backend failure while checking existing data is a message, not an exception', async () => {
  const env = await mkEnv();
  env.st.down = 'network';
  const r = await env.flow();
  assert.equal(r.stage, 'error');
  assert.match(r.message, /offline/);
  const crash = await runImportFlow({ ctx: { backend: { select: async () => { throw new Error('weird'); } }, outbox: env.outbox }, gym: env.gym, snapshot: env.snap(), refresh: async () => {}, file: fileOf(JSON.stringify(mkJson())) });
  assert.equal(crash.message, GENERIC_ERROR);
});

test('possible duplicates: listed, skipped by default, imported with includeDuplicates', async () => {
  const j = mkJson();
  // a native workout on the local day of the first session
  const seed = cleanSeed();
  const firstDay = (await (async () => { const { workoutDay } = await import('../../js/lib/workout.js'); return workoutDay(j.workouts[0].started_at); })());
  seed.workouts.push({ id: '11111111-1111-4111-8111-111111111111', user_id: 'demo-user', routine_id: null, name: 'Native', day: firstDay, started_at: j.workouts[0].started_at, ended_at: j.workouts[0].started_at, duration_known: false, note: '', imported: false, source_ref: null });
  const env = await mkEnv({ seed });
  const r = await env.flow();
  assert.equal(r.preview.possibleDuplicates.length, 1);
  assert.equal(r.preview.newSessions, 2);
  assert.match(r.line, / · 1 possible duplicate$/);
  const ref = r.preview.possibleDuplicates[0].ref;
  const r2 = await env.flow({ includeDuplicates: new Set([ref]) });
  assert.equal(r2.preview.possibleDuplicates.length, 0);
  assert.equal(r2.preview.newSessions, 3);
  await r2.commit();
  assert.equal(imported(env).length, 3);
  // an array is accepted too
  const env2 = await mkEnv({ seed });
  assert.equal((await env2.flow({ includeDuplicates: [ref] })).preview.newSessions, 3);
});

test('re-import after new sessions were added to the file imports only the new ones', async () => {
  const env = await mkEnv();
  await (await env.flow()).commit();
  await env.reload();
  const j = mkJson();
  const more = { ...j, workouts: [...j.workouts, extraSession(1, '2026-12-05T09:00:00.000Z')], counts: { sessions: 4, entries: j.counts.entries + 1, sets: j.counts.sets + 1 } };
  const r = await env.flow({ file: fileOf(JSON.stringify(more)) });
  assert.equal(r.preview.newSessions, 1);
  assert.equal(r.preview.alreadyImported, 3);
  await r.commit();
  assert.equal(imported(env).length, 4);
});

test('no gym index trouble when the runtime has no user yet (rebuildIndex is a no-op)', async () => {
  const env = await mkEnv();
  const r = await runImportFlow({ ctx: env.ctx, gym: { rebuildIndex: async () => {} }, snapshot: env.snap(), refresh: async () => {}, file: fileOf(JSON.stringify(mkJson())) });
  assert.equal((await r.commit()).status, 'done');
});

test('a queue ahead of the import (earlier offline edit) still drains and import reports done', async () => {
  const env = await mkEnv();
  await env.ctx.outbox.enqueue({ kind: 'upsert', table: 'exercises', rows: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Mine', muscle_group: 'core', equipment: 'other', how_to: '', is_custom: true, archived: false }], onConflict: 'id' });
  const r = await env.flow();
  const res = await r.commit();
  assert.equal(res.status, 'done');
  assert.equal(env.outbox.pending(), 0);
  assert.ok(env.rows('exercises').some((e) => e.name === 'Mine'));
});


const LOST_ALL = 'The workouts were imported, but the routines or schedule were not, and repeating the import will not recreate them. You can add routines manually in Gym.';
const foreign = (name) => ({ kind: 'upsert', table: 'exercises', onConflict: 'id', rows: [{ id: crypto.randomUUID(), name, muscle_group: 'core', equipment: 'other', how_to: '', is_custom: true, archived: false }] });

test('a rejected routines op: workouts are in, a repeat will not recreate the routines, and the message says so', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  env.st.failTable = 'routines';
  const res = await r.commit();
  assert.equal(res.status, 'partial');
  assert.equal(res.message, LOST_ALL);
  assert.equal(imported(env).length, 3);
  assert.equal(env.refreshes.length, 1);
  env.st.failTable = null;
  await env.reload();
  const again = await env.flow();
  assert.equal(again.ops.filter((o) => o.table === 'routines').length, 0, 'indeed: a repeat does not recreate them');
});

test('a rejected routine_items op gets the same plain message', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  env.st.failTable = 'routine_items';
  const res = await r.commit();
  assert.equal(res.message, LOST_ALL);
});

test('routines lost while some sessions are missing too: one message with both facts', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  env.st.failTable = 'routines';
  env.st.partial = { table: 'sets', keep: 11 };
  const res = await r.commit();
  assert.equal(res.message, 'Imported 2 of 3 sessions, but the routines or schedule were not saved, and repeating the import will not recreate them. You can add routines manually in Gym.');
});

test('routines rejected but no session landed: a repeat does recreate them, so the plain safe-to-repeat wording stays', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  env.st.failTable = 'routines';
  env.st.partial = { table: 'workouts', keep: 0 };
  const res = await r.commit();
  assert.equal(res.message, 'Imported 0 of 3 sessions; some items failed — try again, the import is safe to repeat.');
});

test('failing sets keeps the safe-to-repeat wording (routines were written)', async () => {
  const env = await mkEnv();
  const res = await (await env.flow()).commit();
  assert.equal(res.status, 'done');
  const env2 = await mkEnv();
  env2.st.failTable = 'sets';
  const res2 = await (await env2.flow()).commit();
  assert.match(res2.message, /the import is safe to repeat\.$/);
  assert.ok(!/routines/.test(res2.message));
});

test('partial count is in sessions and true with foreign ops queued ahead and behind', async () => {
  const env = await mkEnv();
  const r = await env.flow();
  const orig = env.outbox.enqueue;
  let n = 0;
  env.outbox.enqueue = async (op) => { if (n === 0) await orig(foreign('Ahead')); await orig(op); n++; if (n === r.ops.length) await orig(foreign('Behind')); };
  env.st.partial = { table: 'sets', keep: 11 }; // log-1 (7 sets) and log-2 (4) complete, log-3 cut
  const res = await r.commit();
  assert.equal(res.status, 'partial');
  assert.equal(res.message, 'Imported 2 of 3 sessions; some items failed — try again, the import is safe to repeat.');
  assert.equal(env.refreshes.length, 1, 'rebuild and refresh are not gated on an estimate');
  assert.ok(env.rows('exercises').some((e) => e.name === 'Ahead') && env.rows('exercises').some((e) => e.name === 'Behind'));
  assert.equal(env.outbox.pending(), 0);
});

test('a background flush that finished first (its failures lost) cannot make the import look successful', async () => {
  const env = await mkEnv();
  const real = env.outbox.flush.bind(env.outbox);
  let calls = 0;
  env.outbox.flush = () => { calls++; return calls === 1 ? real() : real().then(() => ({ sent: 0, remaining: 0, failed: [] })); };
  env.st.failTable = 'sets';
  const res = await (await env.flow()).commit();
  assert.equal(res.status, 'partial');
  assert.equal(res.message, 'Imported 0 of 3 sessions; some items failed — try again, the import is safe to repeat.');
});

test('a lost failed routines op is found by the server check, not by the flush result', async () => {
  const env = await mkEnv();
  const real = env.outbox.flush.bind(env.outbox);
  let calls = 0;
  env.outbox.flush = () => { calls++; return calls === 1 ? real() : real().then(() => ({ sent: 0, remaining: 0, failed: [] })); };
  env.st.failTable = 'routine_items';
  const res = await (await env.flow()).commit();
  assert.equal(res.message, LOST_ALL);
});

test('success is decided by the server state: a flush that claims success over a backend that stored nothing is not "done"', async () => {
  const env = await mkEnv();
  env.st.swallow = true;
  const res = await (await env.flow()).commit();
  assert.notEqual(res.status, 'done');
  assert.equal(res.status, 'partial');
  assert.equal(imported(env).length, 0);
});

test('post-hoc check failing (offline right after the flush) falls back to the saved-on-device message', async () => {
  const env = await mkEnv();
  env.st.hook = (t) => { if (t === 'sets') env.st.selectDown = true; };
  const res = await (await env.flow()).commit();
  assert.equal(res.status, 'offline');
  assert.equal(res.message, 'Saved on this device. The import finishes when you are back online.');
});

test('repair is reported: only repairs, and new sessions plus repairs', async () => {
  const env = await mkEnv();
  env.st.partial = { table: 'sets', keep: 11 };
  await (await env.flow()).commit();
  env.st.partial = null;
  await env.reload();
  const r2 = await env.flow();
  assert.deepEqual([r2.preview.newSessions, r2.preview.repaired], [0, 1]);
  const res = await r2.commit();
  assert.equal(res.status, 'done');
  assert.equal(res.message, 'Restored missing items for 1 session.');
  assert.equal((await env.flow()).ops.length, 0);
});

test('tombstone interplay: a deleted-then-reimported workout is hidden only while its delete is queued', async () => {
  const env = await mkEnv();
  await (await env.flow()).commit();
  await env.reload();
  await env.gym.rebuildIndex();
  const wid = imported(env)[0].id;
  assert.ok(env.gym.index().workoutIds.includes(wid));
  const { enqueueGym, removeRow } = await import('../../js/data/gym-repo.js');
  env.st.failRemove = true; // the remove stays queued
  await enqueueGym(env.ctx, [removeRow('workouts', wid)]);
  env.gym.forgetWorkout(wid);
  assert.equal(env.gym.isForgotten(wid), true, 'hidden while the delete is queued');
  assert.ok(!env.gym.index().workoutIds.includes(wid));
  await env.outbox.flush(); // settle the stalled attempt, the remove stays queued
  assert.equal(env.outbox.pending(), 1);
  env.st.failRemove = false;
  await env.outbox.flush();
  assert.equal(env.outbox.pending(), 0);
  await env.reload();
  const r = await env.flow();
  assert.equal(r.preview.newSessions, 1, 'the deleted session is importable again');
  assert.equal((await r.commit()).status, 'done');
  assert.equal(env.gym.isForgotten(wid), false, 'visible once the queue drained and it was re-imported');
  assert.ok(env.gym.index().workoutIds.includes(wid), 'the rebuilt index has the re-imported workout');
});
