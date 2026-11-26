import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import * as repo from '../../js/data/repo.js';
import * as gym from '../../js/data/gym-repo.js';
import { GYM_EXERCISES } from '../../js/data/gym-seed.js';
import { validateGymRow } from '../../js/lib/gym-validate.js';
import { seedId } from '../../js/lib/ids.js';
import * as S from '../../js/lib/strive-import.js';
import { mkRaw, mkJson, extraSession, T1, FR_NOTE } from './fixtures/strive-json.mjs';

const { toIso, striveDuration, normaliseStrive, normName, mapExercise, buildImportPlan, ImportError } = S;
const U = 'demo-user';
const TODAY = '2026-12-10';
const ST = T1;
const MIN = 60;
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof ImportError && e.code === code, code);

// ---- toIso ----
test('toIso: seconds to ISO, year window 2020..2030, milliseconds rejected', () => {
  assert.equal(toIso(1782060257), '2026-06-21T16:44:17.000Z');
  throwsCode(() => toIso(1782060257000), 'timestamp');
  assert.equal(toIso(Date.UTC(2020, 0, 1) / 1000), '2020-01-01T00:00:00.000Z');
  assert.equal(toIso(Date.UTC(2030, 11, 31, 23, 59, 59) / 1000), '2030-12-31T23:59:59.000Z');
  throwsCode(() => toIso(Date.UTC(2019, 11, 31, 23, 59, 59) / 1000), 'timestamp');
  throwsCode(() => toIso(Date.UTC(2031, 0, 1) / 1000), 'timestamp');
  throwsCode(() => toIso(null), 'timestamp');
  throwsCode(() => toIso(NaN), 'timestamp');
  throwsCode(() => toIso('1782060257'), 'timestamp');
});

// ---- striveDuration ----
const dur = (o) => striveDuration({ started_at: ST, created_at: ST + 7200, ...o });
test('striveDuration: Strive end kept only for 10 min <= d <= 240 min', () => {
  assert.deepEqual(dur({ ended_at: ST + 71 * MIN }), { ended_at: toIso(ST + 71 * MIN), duration_known: true });
  assert.deepEqual(dur({ ended_at: ST + 10 * MIN }), { ended_at: toIso(ST + 10 * MIN), duration_known: true });
  assert.deepEqual(dur({ ended_at: ST + 10 * MIN - 1 }), { ended_at: toIso(ST), duration_known: false });
  assert.deepEqual(dur({ ended_at: ST + 240 * MIN }), { ended_at: toIso(ST + 240 * MIN), duration_known: true });
  assert.deepEqual(dur({ ended_at: ST + 240 * MIN + 1 }), { ended_at: toIso(ST), duration_known: false });
  assert.deepEqual(dur({ ended_at: ST + 896 * MIN }), { ended_at: toIso(ST), duration_known: false });
  assert.deepEqual(dur({ ended_at: ST + 2 * MIN }), { ended_at: toIso(ST), duration_known: false });
  assert.deepEqual(dur({ ended_at: ST + 9 * MIN + 59 }), { ended_at: toIso(ST), duration_known: false });
});
test('striveDuration: back-filled (created before started) is unknown even with a plausible end; equal is not back-fill', () => {
  assert.deepEqual(striveDuration({ started_at: ST, ended_at: ST + 60 * MIN, created_at: ST - 86400 }), { ended_at: toIso(ST), duration_known: false });
  assert.deepEqual(striveDuration({ started_at: ST, ended_at: ST + 60 * MIN, created_at: ST - 1 }), { ended_at: toIso(ST), duration_known: false });
  assert.deepEqual(striveDuration({ started_at: ST, ended_at: ST + 60 * MIN, created_at: ST }), { ended_at: toIso(ST + 60 * MIN), duration_known: true });
});
test('striveDuration: set times win (max + 120 s) inside 10 min..4 h, else fall through', () => {
  assert.deepEqual(dur({ ended_at: ST + 300 * MIN, setTimes: [ST + 5 * MIN, ST + 30 * MIN] }), { ended_at: toIso(ST + 32 * MIN), duration_known: true });
  // exactly 10 min: last set at 8 min + 120 s
  assert.deepEqual(dur({ ended_at: ST + 300 * MIN, setTimes: [ST + 8 * MIN] }), { ended_at: toIso(ST + 10 * MIN), duration_known: true });
  // 9 min 59 s from sets -> fall through; Strive end 300 min -> unknown
  assert.deepEqual(dur({ ended_at: ST + 300 * MIN, setTimes: [ST + 8 * MIN - 1] }), { ended_at: toIso(ST), duration_known: false });
  // 9 min 59 s from sets -> fall through to a plausible Strive end
  assert.deepEqual(dur({ ended_at: ST + 50 * MIN, setTimes: [ST + 8 * MIN - 1] }), { ended_at: toIso(ST + 50 * MIN), duration_known: true });
  // exactly 4 h from sets, and 1 s over
  assert.deepEqual(dur({ ended_at: ST + 300 * MIN, setTimes: [ST + 238 * MIN] }), { ended_at: toIso(ST + 240 * MIN), duration_known: true });
  assert.deepEqual(dur({ ended_at: ST + 300 * MIN, setTimes: [ST + 238 * MIN + 1] }), { ended_at: toIso(ST), duration_known: false });
  // set times beat the back-fill rule; out-of-range set times on a back-filled session stay unknown
  assert.deepEqual(striveDuration({ started_at: ST, ended_at: ST + 60 * MIN, created_at: ST - 86400, setTimes: [ST + 20 * MIN] }), { ended_at: toIso(ST + 22 * MIN), duration_known: true });
  assert.deepEqual(striveDuration({ started_at: ST, ended_at: ST + 60 * MIN, created_at: ST - 86400, setTimes: [ST + 1 * MIN] }), { ended_at: toIso(ST), duration_known: false });
  // empty setTimes behaves as absent
  assert.deepEqual(dur({ ended_at: ST + 71 * MIN, setTimes: [] }), { ended_at: toIso(ST + 71 * MIN), duration_known: true });
});

// ---- normaliseStrive ----
test('normaliseStrive: shape, counts, 1-based set_no, type mapping, durations', () => {
  const j = normaliseStrive(mkRaw());
  assert.equal(j.format, S.STRIVE_FORMAT);
  assert.deepEqual(j.counts, { sessions: 3, entries: 8, sets: 18 });
  assert.equal(j.workouts.length, 3);
  assert.equal(j.workouts.flatMap((w) => w.exercises).length, 8);
  assert.equal(j.workouts.flatMap((w) => w.exercises).flatMap((e) => e.sets).length, 18);
  const w1 = j.workouts[0];
  assert.equal(w1.ref, 'strive:routine_logs:log-1');
  assert.equal(w1.started_at, '2026-06-21T16:44:17.000Z');
  assert.equal(w1.exercises[0].ref, 'strive:routine_exercise_logs:rel-1');
  assert.deepEqual(w1.exercises[0].sets.map((s) => s.set_no), [1, 2, 3]);
  assert.equal(w1.exercises[0].sets[0].ref, 'strive:routine_exercise_set_logs:rel-1-s0');
  assert.ok(w1.exercises[0].sets.every((s) => s.done_at === w1.started_at));
  const types = j.workouts.flatMap((w) => w.exercises).flatMap((e) => e.sets).map((s) => s.type);
  assert.equal(types.filter((t) => t === 'dropset').length, 1);
  assert.equal(types.filter((t) => t === 'normal').length, 17);
  assert.deepEqual(j.workouts.map((w) => w.duration_known), [true, false, false]);
  assert.equal(j.workouts[2].ended_at, j.workouts[2].started_at);
  assert.equal(j.workouts[1].ended_at, j.workouts[1].started_at);
});
test('normaliseStrive: throws on superset type, imperial unit, bad timestamp', () => {
  const a = mkRaw(); a.routine_exercise_set_logs[0].type = 'superset';
  throwsCode(() => normaliseStrive(a), 'set-type');
  const b = mkRaw(); b.routine_exercise_set_logs[3].is_weight_unit_metric = 0;
  throwsCode(() => normaliseStrive(b), 'unit');
  const c = mkRaw(); c.routine_logs[0].started_at *= 1000;
  throwsCode(() => normaliseStrive(c), 'timestamp');
});
test('normaliseStrive: NULL weight becomes 0 (bodyweight lift) and validates', () => {
  const j = normaliseStrive(mkRaw());
  const crunch = j.workouts[2].exercises[2];
  assert.deepEqual(crunch.sets.map((s) => s.weight_kg), [0, 0]);
  assert.equal(validateGymRow('sets', { id: 'x', ...crunch.sets[0] , workout_exercise_id: 'w', is_pr: false }), null);
  assert.equal(j.workouts[0].exercises[0].sets[0].weight_kg, 40);
});
test('normaliseStrive: French how-to byte-identical, log note on its session, deleted routine excluded', () => {
  const j = normaliseStrive(mkRaw());
  const fp = j.exercises.find((e) => e.name_en === 'Face pull');
  assert.equal(fp.how_to, FR_NOTE);
  assert.ok(fp.how_to.includes('\n') && fp.how_to.startsWith('Exécution'));
  assert.deepEqual(j.workouts.map((w) => w.note), ['Felt strong', '', '']);
  assert.deepEqual(j.routines.map((r) => r.name), ['Upper Force', 'Lower']);
  assert.ok(!j.exercises.some((e) => e.name_en === 'Zottman curl'), 'only owned by the deleted routine');
  assert.ok(!j.exercises.some((e) => e.name_en === 'Never used'));
  assert.deepEqual(j.exercises.find((e) => e.name_en === 'Leg press (Machine)').body_parts, ['quads', 'glutes']);
});
test('normaliseStrive: log note may be owned by the session id; exercise notes alone export their exercise', () => {
  const r = mkRaw();
  r.routine_exercise_notes = [{ id: 'n1', owner_id: 'log-2', type: 'log', note: 'Back-filled', created_at: 1 },
    { id: 'n2', owner_id: 'e10', type: 'exercise', note: 'Keep elbows in', created_at: 2 }];
  const j = normaliseStrive(r);
  assert.deepEqual(j.workouts.map((w) => w.note), ['', 'Back-filled', '']);
  assert.equal(j.exercises.find((e) => e.name_en === 'Never used').how_to, 'Keep elbows in');
});
test('normaliseStrive: template targets (sets clamped 1..10, reps min/max of reps > 0, else 8/12)', () => {
  const j = normaliseStrive(mkRaw());
  const up = j.routines[0];
  assert.equal(up.ref, 'strive:routines:r1');
  assert.deepEqual(up.items.map((i) => [i.exercise_ref, i.position, i.sets, i.reps_min, i.reps_max]), [
    ['strive:exercises:e1', 0, 3, 6, 10],
    ['strive:exercises:e2', 1, 3, 8, 12],   // Seated cable row: null reps
    ['strive:exercises:e3', 2, 2, 10, 12],  // curls: 2 sets
  ]);
  assert.equal(up.items[0].ref, 'strive:routine_exercises:re-1');
  assert.deepEqual(j.routines[1].items.map((i) => [i.sets, i.reps_min, i.reps_max]), [[3, 8, 12]]);
  const many = mkRaw();
  many.routine_exercise_sets = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, routine_id: 'r2', routine_exercise_id: 're-4', exercise_id: 'e5', order: i, reps: 0 }));
  assert.deepEqual(normaliseStrive(many).routines[1].items[0].sets, 10);
  const none = mkRaw();
  none.routine_exercise_sets = none.routine_exercise_sets.filter((s) => s.routine_exercise_id !== 're-4');
  assert.equal(normaliseStrive(none).routines[1].items[0].sets, 1);
});
test('normaliseStrive: workouts link to their routine by ref', () => {
  const j = normaliseStrive(mkRaw());
  assert.deepEqual(j.workouts.map((w) => [w.name, w.routine_ref]), [['Upper Force', 'strive:routines:r1'], ['Lower', 'strive:routines:r2'], ['Upper Force', 'strive:routines:r1']]);
});

// ---- normName / maps / mapExercise ----
test('normName', () => {
  assert.deepEqual(normName('Bicep curls (Dumbbell)'), { name: 'bicep curl', equipment: 'dumbbell' });
  assert.deepEqual(normName('Leg Press'), { name: 'leg press', equipment: null });
  assert.deepEqual(normName('  Cable Push Down - one arm '), { name: 'cable push down one arm', equipment: null });
  assert.deepEqual(normName('Écarté (Cable)'), { name: 'ecarte', equipment: 'cable' });
  assert.deepEqual(normName('Bench Press (Barbell)'), { name: 'bench press', equipment: 'barbell' });
  assert.equal(normName('Abs').name, 'abs');          // 3 chars: kept
  assert.equal(normName('Lats').name, 'lat');         // 4 chars: singularised
  assert.equal(normName('Chess').name, 'chess');      // 'ss' is not a plural
});
test('CATEGORY_EQUIPMENT and BODY_PART_MUSCLE', () => {
  const c = S.CATEGORY_EQUIPMENT;
  assert.deepEqual([c.dumbell, c.barbell, c.olympic, c.cable, c.machine, c.smith, c.reps, c.weigtedBodyweight, c.assistedBodyweight],
    ['dumbbell', 'barbell', 'barbell', 'cable', 'machine', 'machine', 'bodyweight', 'bodyweight', 'bodyweight']);
  assert.equal(c.cardio ?? 'other', 'other');
  const b = S.BODY_PART_MUSCLE;
  assert.deepEqual([b.lats, b.traps, b.erectors, b.frontDelts, b.sideDelts, b.rearDelts, b.neck, b.adductors], ['back', 'back', 'back', 'shoulders', 'shoulders', 'shoulders', 'shoulders', 'glutes']);
  for (const k of ['chest', 'biceps', 'triceps', 'forearms', 'quads', 'hamstrings', 'glutes', 'calves', 'core']) assert.equal(b[k], k);
});
test('STRIVE_MAP: 21 entries, all resolve to a library name or a create', () => {
  const entries = Object.entries(S.STRIVE_MAP);
  assert.equal(entries.length, 21);
  const names = new Set(GYM_EXERCISES.map((e) => e.name));
  for (const [k, v] of entries) {
    assert.equal(k, k.trim().toLowerCase());
    if (typeof v === 'string') assert.ok(names.has(v), `${k} -> ${v}`);
    else {
      assert.deepEqual(Object.keys(v.create).sort(), ['equipment', 'muscle_group'], k);
    }
  }
  assert.equal(S.STRIVE_MAP['incline bench press (dumbbell)'], 'Incline Dumbbell Press');
  assert.equal(S.STRIVE_MAP['chest fly (machine)'], 'Pec Deck');
  assert.equal(S.STRIVE_MAP['cable push down'], 'Triceps Pushdown');
  assert.deepEqual(S.STRIVE_MAP['standing calf raise (dumbbell)'], { create: { muscle_group: 'calves', equipment: 'dumbbell' } });
  assert.deepEqual(S.STRIVE_MAP.crunch, { create: { muscle_group: 'core', equipment: 'bodyweight' } });
  assert.deepEqual(S.STRIVE_MAP['chest supported row'], { create: { muscle_group: 'back', equipment: 'machine' } });
});
test('mapExercise: alias, create-alias, match, create, name clash', () => {
  const lib = GYM_EXERCISES;
  const m = (name_en, category = 'machine', body_parts = ['chest']) => mapExercise({ name_en, category, body_parts }, lib);
  assert.deepEqual(m('  Bicep curl (Dumbbell) ', 'dumbell', ['biceps']), { kind: 'alias', name: 'Dumbbell Curl', equipment: 'dumbbell', muscle_group: 'biceps' });
  assert.deepEqual(m('Crunch', 'reps', ['core']), { kind: 'create', name: 'Crunch', equipment: 'bodyweight', muscle_group: 'core' });
  assert.deepEqual(m('Leg press (Machine)', 'machine', ['quads']), { kind: 'match', name: 'Leg Press', equipment: 'machine', muscle_group: 'quads' });
  assert.deepEqual(m('Lateral raise (Machine)', 'machine', ['sideDelts']), { kind: 'create', name: 'Lateral raise (Machine)', equipment: 'machine', muscle_group: 'shoulders' });
  // equipment from the category when there is no suffix: machine category vs a dumbbell library lift; the exact name clashes -> suffix
  assert.deepEqual(m('Lateral raise', 'machine', ['sideDelts']), { kind: 'create', name: 'Lateral raise (Machine)', equipment: 'machine', muscle_group: 'shoulders' });
  assert.equal(m('Lateral raise', 'dumbell', ['sideDelts']).kind, 'match');
  // unknown body part -> core, unknown category -> other, a brand-new name is kept exactly (trimmed only)
  assert.deepEqual(m('  farmer walk ', 'cardio', ['fullBody']), { kind: 'create', name: 'farmer walk', equipment: 'other', muscle_group: 'core' });
  // only the first body part decides the muscle group
  assert.equal(m('weird thing', 'barbell', ['lats', 'chest']).muscle_group, 'back');
  // name clash with a seed of different equipment: equipment appended
  assert.equal(m('Leg Press', 'barbell', ['quads']).name, 'Leg Press (Barbell)');
  // the clash is case-insensitive and accent-folded (validateExerciseForm's duplicate rule)
  assert.equal(m('Lég press', 'barbell', ['quads']).name, 'Lég press (Barbell)');
});
test('mapExercise: created exercises keep the exact Strive name, muscle/equipment from STRIVE_MAP', () => {
  const m = (name_en, category, body_parts, lib = GYM_EXERCISES, opts) => mapExercise({ name_en, category, body_parts }, lib, opts);
  assert.deepEqual(m('Cable Push Down - one arm', 'cable', ['triceps']), { kind: 'create', name: 'Cable Push Down - one arm', equipment: 'cable', muscle_group: 'triceps' });
  assert.deepEqual(m(' Chest supported row ', 'machine', ['lats']), { kind: 'create', name: 'Chest supported row', equipment: 'machine', muscle_group: 'back' });
  assert.deepEqual(m('Crunch', 'reps', ['core']), { kind: 'create', name: 'Crunch', equipment: 'bodyweight', muscle_group: 'core' });
  assert.deepEqual(m('Standing calf raise (Dumbbell)', 'dumbell', ['calves']), { kind: 'create', name: 'Standing calf raise (Dumbbell)', equipment: 'dumbbell', muscle_group: 'calves' });
  // a clash with ANOTHER exercise falls back to the equipment suffix; the row this import created itself (ownId) is not a clash
  const lib = [{ id: 'mine', name: 'crunch', muscle_group: 'core', equipment: 'bodyweight' }, ...GYM_EXERCISES];
  assert.equal(m('Crunch', 'reps', ['core'], lib).name, 'Crunch (Bodyweight)');
  assert.equal(m('Crunch', 'reps', ['core'], lib, { ownId: 'mine' }).name, 'Crunch');
});

// ---- buildImportPlan on a memory backend ----
async function account({ habits, routines = [], workouts = [], seedLibrary = true } = {}) {
  const gymHabit = { id: 'habit-gym', name: 'Gym', schedule_kind: 'n_per_week', weekdays: null, target_n: 3, sort: 0, archived: false, start_date: '2026-01-01' };
  const backend = createMemoryBackend({
    settings: [{ user_id: U, water_target_l: 2.5, weekly_pages: 100, gym_habit_id: 'habit-gym', gym_seeded_at: null }],
    habits: habits ?? [gymHabit], routines, workouts,
  });
  const outbox = createOutbox({ backend, storage: createMemoryStorage() });
  await outbox.init();
  const ctx = { backend, outbox };
  if (seedLibrary) {
    await gym.ensureGymDefaults(ctx, await repo.loadSnapshot(ctx, TODAY));
    await outbox.flush();
  }
  return { ctx, backend, outbox };
}
const plan = async (ctx, json, extra = {}) => {
  const snapshot = await repo.loadSnapshot(ctx, TODAY);
  const importState = await gym.fetchImportState(ctx);
  return buildImportPlan({ json, snapshot, importState, userId: U, ...extra });
};
const apply = async (ctx, ops) => { await gym.enqueueGym(ctx, ops); return ctx.outbox.flush(); };
const run = async (ctx, json, extra) => { const p = await plan(ctx, json, extra); const r = await apply(ctx, p.ops); return { ...p, flushed: r }; };
const count = (backend, t) => (backend.dump()[t] ?? []).length;
const rowsOf = (ops, table) => ops.filter((o) => o.table === table).flatMap((o) => o.rows);
const tables = (ops) => ops.map((o) => o.table);

test('plan on an empty account: full import, validated rows, no habit_logs, schedule and gym habit', async () => {
  const { ctx, backend } = await account();
  const json = mkJson();
  const p = await plan(ctx, json);
  // every emitted gym row passes the real validator; batches <= 200; order is the documented one
  for (const op of p.ops) {
    assert.ok(op.rows.length >= 1 && op.rows.length <= 200);
    for (const row of op.rows) assert.equal(validateGymRow(op.table, row), null, `${op.table} ${JSON.stringify(row)}`);
  }
  const order = ['exercises', 'routines', 'routine_items', 'schedule_slots', 'habits', 'workouts', 'workout_exercises', 'sets'];
  const seen = [...new Set(tables(p.ops))];
  assert.deepEqual(seen, order);
  assert.ok(!tables(p.ops).includes('habit_logs'));
  const res = await apply(ctx, p.ops);
  assert.deepEqual(res.failed, []);
  const d = backend.dump();
  assert.equal(d.workouts.length, 3);
  assert.equal(d.workout_exercises.length, 8);
  assert.equal(d.sets.length, 18);
  assert.ok(d.workouts.every((w) => w.imported === true && w.source_ref.startsWith('strive:routine_logs:')));
  assert.equal(d.habit_logs?.length ?? 0, 0);
  assert.equal(d.routines.length, 2);
  assert.equal(d.routine_items.length, 4);
  assert.equal(d.schedule_slots.length, 7);
  assert.deepEqual(d.schedule_slots.map((s) => s.routine_id !== null ? 1 : 0), [1, 1, 0, 1, 1, 0, 0]);
  assert.equal(d.habits.find((h) => h.id === 'habit-gym').target_n, 4);
  assert.deepEqual(p.preview.mapping.map((m) => [m.strive, m.lifeos, m.kind, m.renamed]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['Bicep curl (Dumbbell)', 'Dumbbell Curl', 'alias', 'Bicep curl (Dumbbell)'], ['Crunch', 'Crunch', 'create', null],
    ['Face pull', 'Face Pull', 'alias', 'Face pull'],
    ['Incline Bench Press (Dumbbell)', 'Incline Dumbbell Press', 'alias', 'Incline Bench Press (Dumbbell)'],
    ['Lateral raise (Machine)', 'Lateral raise (Machine)', 'create', null],
    ['Leg press (Machine)', 'Leg Press', 'match', 'Leg press (Machine)'], ['Seated cable row', 'Seated Cable Row', 'alias', 'Seated cable row'],
  ]);
  const { mapping, ...rest } = p.preview;
  assert.deepEqual(rest, { sessions: 3, entries: 8, sets: 18, routines: 2, exercisesCreated: 2, howToNotes: 1, sessionNotes: 1,
    alreadyImported: 0, possibleDuplicates: [], newSessions: 3, repaired: 0 });
  assert.deepEqual(p.preview.possibleDuplicates, []);
  // schedule rows carry deterministic ids (A4)
  const sl = d.schedule_slots.find((s) => s.weekday === 3);
  assert.equal(sl.id, await seedId(U, 'schedule:3'));
  // workouts link to the created routines
  const upper = d.routines.find((r) => r.name === 'Upper Force');
  assert.equal(upper.id, await seedId(U, 'strive:routines:r1'));
  assert.deepEqual(d.workouts.map((w) => [w.name, w.routine_id === upper.id]).sort(), [['Lower', false], ['Upper Force', true], ['Upper Force', true]]);
  assert.ok(d.workouts.find((w) => w.name === 'Lower').routine_id);
  assert.deepEqual(d.routines.map((r) => r.sort).sort(), [0, 1]);
});

test('plan: ids are deterministic and stable across independent runs', async () => {
  const a = await account(); const b = await account();
  const pa = await plan(a.ctx, mkJson()); const pb = await plan(b.ctx, mkJson());
  assert.deepEqual(pa.ops.map((o) => o.rows.map((r) => r.id)), pb.ops.map((o) => o.rows.map((r) => r.id)));
  const w = rowsOf(pa.ops, 'workouts')[0];
  assert.equal(w.id, await seedId(U, 'strive:routine_logs:log-1'));
  assert.equal(rowsOf(pa.ops, 'sets')[0].id, await seedId(U, 'strive:routine_exercise_set_logs:rel-1-s0'));
});

test('plan: workout day is the device-local day of the timestamp (TZ pinned by npm test)', async () => {
  assert.ok(['Europe/Paris', 'Pacific/Auckland'].includes(process.env.TZ), `TZ=${process.env.TZ}`);
  const { ctx } = await account();
  const p = await plan(ctx, mkJson());
  const w = rowsOf(p.ops, 'workouts').find((r) => r.source_ref === 'strive:routine_logs:log-1');
  assert.equal(w.started_at, '2026-06-21T16:44:17.000Z');
  assert.equal(w.day, process.env.TZ === 'Pacific/Auckland' ? '2026-06-22' : '2026-06-21');
  assert.equal(w.duration_known, true);
  assert.equal(w.note, 'Felt strong');
  const unknown = rowsOf(p.ops, 'workouts').find((r) => r.source_ref === 'strive:routine_logs:log-3');
  assert.equal(unknown.duration_known, false);
  assert.equal(unknown.ended_at, unknown.started_at);
});

test('plan: workout name is cut to 40 chars; children reference the right parents', async () => {
  const { ctx } = await account();
  const json = mkJson();
  json.workouts[0].name = 'X'.repeat(55);
  const p = await plan(ctx, json);
  const w = rowsOf(p.ops, 'workouts')[0];
  assert.equal(w.name.length, 40);
  assert.equal(validateGymRow('workouts', w), null);
  const wes = rowsOf(p.ops, 'workout_exercises');
  assert.equal(wes.filter((x) => x.workout_id === w.id).length, 3);
  const weIds = new Set(wes.map((x) => x.id));
  assert.ok(rowsOf(p.ops, 'sets').every((s) => weIds.has(s.workout_exercise_id)));
});

test('plan: is_pr is false for the first session of each exercise, true for a heavier later session', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  const d = backend.dump();
  const weById = new Map(d.workout_exercises.map((x) => [x.id, x]));
  const wById = new Map(d.workouts.map((x) => [x.id, x]));
  const first = new Map(); // exercise -> earliest started_at
  for (const we of d.workout_exercises) {
    const t = wById.get(we.workout_id).started_at;
    if (!first.has(we.exercise_id) || t < first.get(we.exercise_id)) first.set(we.exercise_id, t);
  }
  for (const s of d.sets) {
    const we = weById.get(s.workout_exercise_id);
    if (wById.get(we.workout_id).started_at === first.get(we.exercise_id)) assert.equal(s.is_pr, false, s.id);
  }
  const incline = d.exercises.find((e) => e.name === 'Incline Bench Press (Dumbbell)');
  const later = d.workout_exercises.find((x) => x.exercise_id === incline.id && wById.get(x.workout_id).source_ref === 'strive:routine_logs:log-3');
  const laterSets = d.sets.filter((s) => s.workout_exercise_id === later.id).sort((a, b) => a.set_no - b.set_no);
  assert.equal(laterSets[0].is_pr, true);  // 10 x 42.5 beats 10 x 40
});

test('plan: exercise ids (seed id, created id), how-to replace, created rows', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  const d = backend.dump();
  const byName = (n) => d.exercises.find((e) => e.name === n);
  assert.equal(byName('Face pull').id, await seedId(U, 'face-pull'));
  assert.equal(byName('Face pull').how_to, FR_NOTE);
  const lat = byName('Lateral raise (Machine)');
  assert.equal(lat.id, await seedId(U, 'strive:exercises:e6'));
  assert.deepEqual([lat.muscle_group, lat.equipment, lat.is_custom, lat.archived, lat.how_to], ['shoulders', 'machine', false, false, '']);
  assert.equal(byName('Crunch').equipment, 'bodyweight');
  // library lifts not touched by the import keep their seed text
  assert.equal(byName('Leg press (Machine)').how_to, GYM_EXERCISES.find((e) => e.name === 'Leg Press').how_to);
  assert.equal(d.exercises.length, GYM_EXERCISES.length + 2);
});

test('plan: library not seeded in the snapshot -> seed rows are upserted with ignoreDuplicates', async () => {
  const { ctx, backend } = await account({ seedLibrary: false });
  const p = await plan(ctx, mkJson());
  const first = p.ops.find((o) => o.table === 'exercises');
  assert.equal(first.ignoreDuplicates, true);
  const face = first.rows.find((r) => r.name === 'Face Pull');
  assert.equal(face.id, await seedId(U, 'face-pull'));
  assert.equal(face.how_to, GYM_EXERCISES.find((e) => e.name === 'Face Pull').how_to);
  await apply(ctx, p.ops);
  assert.equal(backend.dump().exercises.find((e) => e.name === 'Face pull').how_to, FR_NOTE);
});

test('how-to ops: creates ignoreDuplicates, updates are full rows without it', async () => {
  const { ctx } = await account();
  const p = await plan(ctx, mkJson());
  const ex = p.ops.filter((o) => o.table === 'exercises');
  assert.equal(ex.length, 2);
  assert.equal(ex[0].ignoreDuplicates, true);
  assert.equal(ex[1].ignoreDuplicates, undefined);
  assert.equal(ex[1].rows.length, 5); // 5 renames, one of them (Face pull) also carries the how-to
  for (const r of ex[1].rows) assert.deepEqual(Object.keys(r).sort(), ['archived', 'equipment', 'how_to', 'id', 'is_custom', 'muscle_group', 'name']);
  const face = ex[1].rows.find((r) => r.id === p.exerciseMap.get('strive:exercises:e4').id);
  assert.deepEqual([face.name, face.how_to], ['Face pull', FR_NOTE]);
});

test('re-run after a complete import: newSessions 0, zero ops, alreadyImported 3', async () => {
  const { ctx } = await account();
  await run(ctx, mkJson());
  const p = await plan(ctx, mkJson());
  assert.equal(p.preview.newSessions, 0);
  assert.equal(p.preview.alreadyImported, 3);
  assert.deepEqual(p.ops, []);
});

test('half-applied (workouts only): re-run fills missing children and nothing else (A1)', async () => {
  const { ctx, backend } = await account();
  const p1 = await plan(ctx, mkJson());
  await apply(ctx, p1.ops.filter((o) => !['workout_exercises', 'sets'].includes(o.table)));
  assert.equal(count(backend, 'workouts'), 3);
  assert.equal(count(backend, 'sets'), 0);
  const p2 = await plan(ctx, mkJson());
  assert.equal(p2.preview.newSessions, 0);
  assert.equal(p2.preview.alreadyImported, 3);
  assert.deepEqual([...new Set(tables(p2.ops))], ['workout_exercises', 'sets']);
  assert.ok(p2.ops.every((o) => o.ignoreDuplicates === true));
  const res = await apply(ctx, p2.ops);
  assert.deepEqual(res.failed, []);
  assert.equal(count(backend, 'workout_exercises'), 8);
  assert.equal(count(backend, 'sets'), 18);
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
});

test('half-applied (one workout complete, one with entries but missing sets, one bare)', async () => {
  const { ctx, backend } = await account();
  const p1 = await plan(ctx, mkJson());
  const ids = await Promise.all(['log-1', 'log-2', 'log-3'].map((k) => seedId(U, `strive:routine_logs:${k}`)));
  const keepSetsOf = new Set(rowsOf(p1.ops, 'workout_exercises').filter((x) => x.workout_id === ids[0]).map((x) => x.id));
  const ops = p1.ops.map((o) => {
    if (o.table === 'workout_exercises') return { ...o, rows: o.rows.filter((r) => r.workout_id !== ids[2]) };
    if (o.table === 'sets') return { ...o, rows: o.rows.filter((r) => keepSetsOf.has(r.workout_exercise_id)) };
    return o;
  });
  await apply(ctx, ops);
  assert.equal(count(backend, 'sets'), 7);
  const p2 = await plan(ctx, mkJson());
  assert.equal(p2.preview.newSessions, 0);
  // the complete workout (3 entries / 7 sets) is not re-emitted
  assert.ok(!rowsOf(p2.ops, 'workout_exercises').some((r) => r.workout_id === ids[0]));
  await apply(ctx, p2.ops);
  assert.equal(count(backend, 'workout_exercises'), 8);
  assert.equal(count(backend, 'sets'), 18);
});

test('half-applied at every cut point: final rows equal the full import and nothing fails', async () => {
  const full = await account();
  await run(full.ctx, mkJson());
  const want = full.backend.dump();
  const n = (await plan((await account()).ctx, mkJson())).ops.length;
  for (let k = 0; k <= n; k++) {
    const { ctx, backend } = await account();
    const p1 = await plan(ctx, mkJson());
    await apply(ctx, p1.ops.slice(0, k));
    const p2 = await plan(ctx, mkJson());
    const res = await apply(ctx, p2.ops);
    assert.deepEqual(res.failed, [], `cut ${k}`);
    const got = backend.dump();
    for (const t of ['exercises', 'routines', 'routine_items', 'schedule_slots', 'workouts', 'workout_exercises', 'sets']) {
      assert.equal(got[t].length, want[t].length, `cut ${k} ${t}`);
    }
    assert.equal(got.habits[0].target_n, 4, `cut ${k} habit`);
    assert.equal(got.exercises.find((e) => e.name === 'Face pull').how_to, FR_NOTE, `cut ${k} how-to`);
    assert.deepEqual(got.exercises.map((e) => [e.id, e.name]).sort(), want.exercises.map((e) => [e.id, e.name]).sort(), `cut ${k} names`);
    assert.deepEqual(got.sets.map((s) => s.id).sort(), want.sets.map((s) => s.id).sort(), `cut ${k}`);
    assert.deepEqual((await plan(ctx, mkJson())).ops, [], `cut ${k} converged`);
  }
});

test('newer JSON with 2 extra sessions: only those 2 arrive; a same-day native workout is a possible duplicate', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  await backend.upsert('workouts', [{ id: 'native', name: 'Push', day: '2026-12-03', started_at: '2026-12-03T08:00:00.000Z', ended_at: '2026-12-03T09:00:00.000Z', duration_known: true, note: '', imported: false }]);
  const j = mkJson();
  j.workouts.push(extraSession(1, '2026-12-01T10:00:00.000Z'), extraSession(2, '2026-12-03T10:00:00.000Z'));
  j.counts = { sessions: 5, entries: 10, sets: 20 };
  const p = await plan(ctx, j);
  assert.equal(p.preview.alreadyImported, 3);
  assert.equal(p.preview.newSessions, 1);
  assert.deepEqual(p.preview.possibleDuplicates, [{ ref: 'strive:routine_logs:extra-2', day: '2026-12-03', name: 'Upper Force' }]);
  assert.deepEqual(rowsOf(p.ops, 'workouts').map((w) => w.source_ref), ['strive:routine_logs:extra-1']);
  assert.equal(rowsOf(p.ops, 'sets').length, 1);
  assert.ok(!tables(p.ops).some((t) => ['exercises', 'routines', 'routine_items', 'schedule_slots', 'habits'].includes(t)));
  // with the escape hatch both arrive
  const q = await plan(ctx, j, { includeDuplicates: new Set(['strive:routine_logs:extra-2']) });
  assert.equal(q.preview.newSessions, 2);
  assert.deepEqual(q.preview.possibleDuplicates, []);
  await apply(ctx, q.ops);
  assert.equal(count(backend, 'workouts'), 6);
  // the new sets' PR flags are computed against ALL json sessions: extra-1 (22.5) is the first Face Pull session? no, log-1 is earlier
  const fp = backend.dump().sets.find((s) => s.id === rowsOf(q.ops, 'sets')[0].id);
  assert.equal(typeof fp.is_pr, 'boolean');
});

test('possible duplicate boundary: a native workout on the previous day does not block', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  await backend.upsert('workouts', [{ id: 'native', name: 'Push', day: '2026-12-02', started_at: '2026-12-02T08:00:00.000Z', ended_at: '2026-12-02T09:00:00.000Z', duration_known: true, note: '', imported: false }]);
  const j = mkJson();
  j.workouts.push(extraSession(1, '2026-12-03T10:00:00.000Z'));
  j.counts = { sessions: 4, entries: 9, sets: 19 };
  const p = await plan(ctx, j);
  assert.equal(p.preview.newSessions, 1);
  assert.deepEqual(p.preview.possibleDuplicates, []);
});

test('an imported workout on a day with only imported workouts is not a duplicate of itself', async () => {
  const { ctx } = await account();
  await run(ctx, mkJson());
  const j = mkJson();
  const dup = extraSession(7, j.workouts[0].started_at);
  j.workouts.push(dup); j.counts = { sessions: 4, entries: 9, sets: 19 };
  const p = await plan(ctx, j);
  assert.equal(p.preview.newSessions, 1);
  assert.deepEqual(p.preview.possibleDuplicates, []);
});

test('edited how-to survives a re-run; seed text is replaced by his note', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  assert.equal(backend.dump().exercises.find((e) => e.name === 'Face pull').how_to, FR_NOTE);
  const id = await seedId(U, 'face-pull');
  await backend.upsert('exercises', [{ id, how_to: 'my own words' }], { onConflict: 'id' });
  const p = await plan(ctx, mkJson());
  assert.deepEqual(p.ops, []);
  assert.equal(backend.dump().exercises.find((e) => e.id === id).how_to, 'my own words');
  // a how_to that is neither empty nor the seed text is never replaced, even on a first import
  const fresh = await account();
  await fresh.backend.upsert('exercises', [{ id, how_to: 'edited before import' }], { onConflict: 'id' });
  const p2 = await plan(fresh.ctx, mkJson());
  // (the untouched seed name still takes the Strive name; his how-to rides along unchanged)
  assert.deepEqual(rowsOf(p2.ops, 'exercises').filter((r) => r.id === id).map((r) => [r.name, r.how_to]), [['Face pull', 'edited before import']]);
  // an empty how_to counts as unset
  await fresh.backend.upsert('exercises', [{ id, how_to: '' }], { onConflict: 'id' });
  const p3 = await plan(fresh.ctx, mkJson());
  assert.equal(rowsOf(p3.ops, 'exercises').find((r) => r.id === id).how_to, FR_NOTE);
});

test('routine named like the import already exists: no new routine, workouts link to it', async () => {
  const { ctx, backend } = await account({ routines: [{ id: 'mine', name: 'Upper Force', sort: 0, archived: false }] });
  const p = await plan(ctx, mkJson());
  const created = rowsOf(p.ops, 'routines');
  assert.deepEqual(created.map((r) => r.name), ['Lower']);
  assert.ok(rowsOf(p.ops, 'routine_items').every((i) => i.routine_id !== 'mine'));
  assert.equal(rowsOf(p.ops, 'routine_items').length, 1);
  const wk = rowsOf(p.ops, 'workouts');
  assert.deepEqual(wk.filter((w) => w.name === 'Upper Force').map((w) => w.routine_id), ['mine', 'mine']);
  await apply(ctx, p.ops);
  assert.equal(count(backend, 'routines'), 2);
});

test('both routines exist by name: nothing created, no schedule, no habit patch; workouts still link', async () => {
  const { ctx } = await account({ routines: [{ id: 'a', name: 'upper force', sort: 0 }, { id: 'b', name: 'LOWER', sort: 1 }] });
  const p = await plan(ctx, mkJson());
  assert.ok(!tables(p.ops).some((t) => ['routines', 'routine_items', 'schedule_slots', 'habits'].includes(t)));
  assert.deepEqual(rowsOf(p.ops, 'workouts').map((w) => w.routine_id).sort(), ['a', 'a', 'b']);
});

test('existing schedule slots are kept: no schedule rows, no habit patch', async () => {
  const { ctx, backend } = await account();
  await backend.upsert('schedule_slots', [{ id: 'sl1', weekday: 1, routine_id: null }], { onConflict: 'id' });
  const p = await plan(ctx, mkJson());
  assert.ok(!tables(p.ops).includes('schedule_slots'));
  assert.ok(!tables(p.ops).includes('habits'));
});

test('schedule picks upper/lower by name, falls back to sort; gym habit already at 4 is not patched', async () => {
  const { ctx } = await account({ habits: [{ id: 'habit-gym', name: 'Gym', schedule_kind: 'n_per_week', target_n: 4, sort: 0 }] });
  const j = mkJson();
  j.routines[0].name = 'Push day'; j.routines[1].name = 'Pull day'; // no upper/lower in the names -> sort order
  const p = await plan(ctx, j);
  const slots = rowsOf(p.ops, 'schedule_slots');
  const up = await seedId(U, 'strive:routines:r1'); const lo = await seedId(U, 'strive:routines:r2');
  assert.deepEqual(slots.map((s) => s.routine_id), [up, lo, null, up, lo, null, null]);
  assert.deepEqual(slots.map((s) => s.weekday), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(p.ops.find((o) => o.table === 'schedule_slots').onConflict, 'user_id,weekday');
  assert.ok(!tables(p.ops).includes('habits'));
  // names win over sort: Lower listed first
  const k = mkJson(); k.routines.reverse();
  const q = await plan(ctx, k);
  assert.equal(rowsOf(q.ops, 'schedule_slots')[0].routine_id, up);
});

test('no gym habit in the snapshot: schedule still written, no habit op', async () => {
  const { ctx } = await account({ habits: [{ id: 'h2', name: 'Read', schedule_kind: 'daily', sort: 0 }] });
  const p = await plan(ctx, mkJson());
  assert.ok(tables(p.ops).includes('schedule_slots'));
  assert.ok(!tables(p.ops).includes('habits'));
});

test('batches never exceed 200 rows', async () => {
  const { ctx } = await account();
  const j = mkJson();
  const w = extraSession(9, '2026-12-05T10:00:00.000Z');
  w.exercises = Array.from({ length: 10 }, (_, e) => ({ ref: `strive:routine_exercise_logs:big-${e}`, exercise_ref: 'strive:exercises:e4', position: e,
    sets: Array.from({ length: 45 }, (_, i) => ({ ref: `strive:routine_exercise_set_logs:big-${e}-${i}`, set_no: i + 1, reps: 10, weight_kg: 20, type: 'normal', done_at: w.started_at })) }));
  j.workouts.push(w); j.counts = { sessions: 4, entries: 18, sets: 468 };
  const p = await plan(ctx, j);
  const setOps = p.ops.filter((o) => o.table === 'sets');
  assert.deepEqual(setOps.map((o) => o.rows.length), [200, 200, 68]);
  for (const o of p.ops) assert.ok(o.rows.length <= 200);
  const res = await apply(ctx, p.ops);
  assert.deepEqual(res.failed, []);
});

test('buildImportPlan validates format and counts', async () => {
  const { ctx } = await account();
  const bad = async (j, code) => assert.rejects(plan(ctx, j), (e) => e instanceof ImportError && e.code === code, code);
  await bad({ ...mkJson(), format: 'nope' }, 'format');
  await bad({ ...mkJson(), format: undefined }, 'format');
  await bad({ ...mkJson(), counts: { sessions: 4, entries: 8, sets: 18 } }, 'counts');
  await bad({ ...mkJson(), counts: { sessions: 3, entries: 9, sets: 18 } }, 'counts');
  await bad({ ...mkJson(), counts: { sessions: 3, entries: 8, sets: 17 } }, 'counts');
  await bad({ ...mkJson(), counts: undefined }, 'counts');
});

test('exerciseMap and unmapped refs', async () => {
  const { ctx } = await account();
  const p = await plan(ctx, mkJson());
  assert.equal(p.exerciseMap.get('strive:exercises:e4').id, await seedId(U, 'face-pull'));
  assert.equal(p.exerciseMap.get('strive:exercises:e6').kind, 'create');
  const j = mkJson(); j.workouts[0].exercises[0].exercise_ref = 'strive:exercises:nope';
  await assert.rejects(plan(ctx, j), ImportError);
});

test('two Strive exercises resolving to one library lift share one exercise id', async () => {
  const { ctx } = await account();
  const j = mkJson();
  j.exercises.push({ ref: 'strive:exercises:dup', name_en: 'Cable push down', body_parts: ['triceps'], category: 'cable', how_to: '' },
    { ref: 'strive:exercises:dup2', name_en: 'Tricep pushdown (Cable)', body_parts: ['triceps'], category: 'cable', how_to: '' });
  const p = await plan(ctx, j);
  assert.equal(p.exerciseMap.get('strive:exercises:dup').id, p.exerciseMap.get('strive:exercises:dup2').id);
  // the first Strive name (export order) names the lift; the second is only an alias: one row, no second rename
  const id = await seedId(U, 'triceps-pushdown');
  assert.deepEqual(rowsOf(p.ops, 'exercises').filter((r) => r.id === id).map((r) => r.name), ['Cable push down']);
  assert.deepEqual(p.preview.mapping.filter((m) => m.strive.includes('ushdown') || m.strive.includes('push down')).map((m) => [m.strive, m.lifeos, m.renamed]),
    [['Cable push down', 'Triceps Pushdown', 'Cable push down'], ['Tricep pushdown (Cable)', 'Triceps Pushdown', null]]);
  for (const op of p.ops) for (const r of op.rows) assert.equal(validateGymRow(op.table, r), null);
  await apply(ctx, p.ops);
  assert.deepEqual((await plan(ctx, j)).ops, []);
});

// ---- review round 1 ----
test('user-renamed exercises (seeded and created) are found by deterministic id: re-run touches nothing', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  const face = await seedId(U, 'face-pull'), lat = await seedId(U, 'strive:exercises:e6'), leg = await seedId(U, 'leg-press');
  await backend.upsert('exercises', [{ id: face, name: 'Rope Pulls', muscle_group: 'back' }, { id: lat, name: 'Side Raise Machine', equipment: 'other' }, { id: leg, name: 'Sled Press' }], { onConflict: 'id' });
  const p = await plan(ctx, mkJson());
  assert.deepEqual(p.ops, []);
  assert.equal(p.exerciseMap.get('strive:exercises:e4').id, face);
  assert.equal(p.exerciseMap.get('strive:exercises:e6').id, lat);
  assert.equal(p.exerciseMap.get('strive:exercises:e5').id, leg);
  const d = backend.dump().exercises;
  assert.equal(d.find((e) => e.id === face).name, 'Rope Pulls');
  assert.equal(d.find((e) => e.id === face).muscle_group, 'back');
  assert.equal(d.find((e) => e.id === lat).equipment, 'other');
});
test('renamed seeded exercise before the first import: no seed row re-emitted, how-to row keeps his name', async () => {
  const { ctx, backend } = await account();
  const face = await seedId(U, 'face-pull');
  await backend.upsert('exercises', [{ id: face, name: 'Rope Pulls', muscle_group: 'back' }], { onConflict: 'id' });
  const p = await plan(ctx, mkJson());
  const rows = rowsOf(p.ops, 'exercises').filter((r) => r.id === face);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Rope Pulls');
  assert.equal(rows[0].muscle_group, 'back');
  assert.equal(rows[0].how_to, FR_NOTE);
  assert.equal(p.ops.find((o) => o.rows.some((r) => r.id === face)).ignoreDuplicates, undefined);
  assert.ok(!rowsOf(p.ops, 'exercises').some((r) => r.name === 'Face Pull'));
  await apply(ctx, p.ops);
  const ex = backend.dump().exercises;
  assert.equal(ex.filter((e) => e.id === face).length, 1);
  assert.equal(ex.find((e) => e.id === face).name, 'Rope Pulls');
});
test('renamed created exercise with an emptied how-to is still found and filled, name kept', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  const face = await seedId(U, 'face-pull');
  await backend.upsert('exercises', [{ id: face, name: 'Rope Pulls', how_to: '' }], { onConflict: 'id' });
  const p = await plan(ctx, mkJson());
  assert.deepEqual(rowsOf(p.ops, 'exercises').map((r) => [r.id, r.name, r.how_to]), [[face, 'Rope Pulls', FR_NOTE]]);
});

test('re-run emits no routine or item after he deleted a routine or emptied one (A: gated on first import)', async () => {
  const { ctx, backend } = await account();
  await run(ctx, mkJson());
  const r1 = await seedId(U, 'strive:routines:r1'), r2 = await seedId(U, 'strive:routines:r2');
  await backend.remove('routine_items', { eq: { routine_id: r2 } });
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
  await backend.remove('routines', { eq: { id: r1 } });
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
  // new sessions of the deleted routine still import, unlinked
  const j = mkJson(); j.workouts.push(extraSession(1, '2026-12-01T10:00:00.000Z')); j.counts = { sessions: 4, entries: 9, sets: 19 };
  const p = await plan(ctx, j);
  assert.deepEqual([...new Set(tables(p.ops))], ['workouts', 'workout_exercises', 'sets']);
  assert.equal(rowsOf(p.ops, 'workouts')[0].routine_id, null);
});
test('cut after routines and items but before any workout: re-plan adds no duplicate routine, converges', async () => {
  const { ctx, backend } = await account();
  const p1 = await plan(ctx, mkJson());
  await apply(ctx, p1.ops.filter((o) => ['exercises', 'routines', 'routine_items'].includes(o.table)));
  const p2 = await plan(ctx, mkJson());
  assert.ok(!tables(p2.ops).includes('routines') && !tables(p2.ops).includes('routine_items'));
  await apply(ctx, p2.ops);
  assert.equal(count(backend, 'routines'), 2);
  assert.equal(count(backend, 'routine_items'), 4);
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
});

test('how-to and session note length: 2000 accepted, 2001 rejected naming the culprit', async () => {
  const { ctx } = await account();
  const ok = mkJson(); ok.exercises[3].how_to = 'é'.repeat(2000); ok.workouts[0].note = 'n'.repeat(2000);
  const p = await plan(ctx, ok);
  for (const op of p.ops) for (const r of op.rows) assert.equal(validateGymRow(op.table, r), null);
  const badHow = mkJson(); badHow.exercises[3].how_to = 'x'.repeat(2001);
  await assert.rejects(plan(ctx, badHow), (e) => e instanceof ImportError && e.code === 'format' && /Face pull/.test(e.message));
  const badNote = mkJson(); badNote.workouts[1].note = 'x'.repeat(2001);
  await assert.rejects(plan(ctx, badNote), (e) => e instanceof ImportError && e.code === 'format' && /Lower/.test(e.message));
});

test('half-applied: entries all present but sets short -> only the sets of that workout are completed', async () => {
  const { ctx, backend } = await account();
  const p1 = await plan(ctx, mkJson());
  const ids = await Promise.all(['log-1', 'log-2', 'log-3'].map((k) => seedId(U, `strive:routine_logs:${k}`)));
  const we2 = new Set(rowsOf(p1.ops, 'workout_exercises').filter((x) => x.workout_id === ids[1]).map((x) => x.id));
  await apply(ctx, p1.ops.map((o) => (o.table === 'sets' ? { ...o, rows: o.rows.filter((r) => !(we2.has(r.workout_exercise_id) && r.set_no === 2)) } : o)));
  assert.equal(count(backend, 'workout_exercises'), 8);
  assert.equal(count(backend, 'sets'), 16);
  const p2 = await plan(ctx, mkJson());
  assert.equal(p2.preview.repaired, 1);
  assert.ok(rowsOf(p2.ops, 'workout_exercises').every((r) => r.workout_id === ids[1]));
  await apply(ctx, p2.ops);
  assert.equal(count(backend, 'sets'), 18);
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
});

// ---- exact Strive names ----
const exRows = (ops) => ops.filter((o) => o.table === 'exercises' && !o.ignoreDuplicates).flatMap((o) => o.rows);
test('exact names: untouched library targets are renamed to the Strive name, one row per exercise, all rows valid', async () => {
  const { ctx, backend } = await account();
  const p = await plan(ctx, mkJson());
  for (const op of p.ops) for (const r of op.rows) assert.equal(validateGymRow(op.table, r), null, `${op.table} ${JSON.stringify(r)}`);
  const ids = exRows(p.ops).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'one upsert row per exercise');
  await apply(ctx, p.ops);
  const d = backend.dump().exercises;
  const nameOf = async (key) => { const id = await seedId(U, key); return d.find((e) => e.id === id).name; };
  assert.equal(await nameOf('incline-dumbbell-press'), 'Incline Bench Press (Dumbbell)');
  assert.equal(await nameOf('dumbbell-curl'), 'Bicep curl (Dumbbell)');
  assert.equal(await nameOf('face-pull'), 'Face pull');
  assert.equal(await nameOf('seated-cable-row'), 'Seated cable row');
  assert.equal(await nameOf('leg-press'), 'Leg press (Machine)');
  assert.equal(await nameOf('strive:exercises:e8'), 'Crunch');
  assert.equal(await nameOf('strive:exercises:e6'), 'Lateral raise (Machine)');
  // library lifts the import does not use keep their seed name
  assert.equal(await nameOf('lat-pulldown'), 'Lat Pulldown');
  assert.equal(d.length, GYM_EXERCISES.length + 2);
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
});
test('exact names: a lift he already renamed (or a same-named row that is not the seed) is never renamed', async () => {
  const { ctx, backend } = await account();
  const face = await seedId(U, 'face-pull'), curl = await seedId(U, 'dumbbell-curl');
  await backend.upsert('exercises', [{ id: face, name: 'Rope Pulls' }, { id: curl, name: 'dumbbell curl' }], { onConflict: 'id' });
  const p = await plan(ctx, mkJson());
  assert.deepEqual(exRows(p.ops).filter((r) => r.id === face).map((r) => r.name), ['Rope Pulls']);
  assert.ok(!exRows(p.ops).some((r) => r.id === curl));
  assert.equal(p.preview.mapping.find((m) => m.strive === 'Face pull').renamed, null);
  assert.equal(p.preview.mapping.find((m) => m.strive === 'Face pull').lifeos, 'Rope Pulls');
  await apply(ctx, p.ops);
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
  // library not seeded: a custom row named like the seed (other id) is his, not the seed -> no rename
  const fresh = await account({ seedLibrary: false });
  await fresh.backend.upsert('exercises', [{ id: 'mine', name: 'Face Pull', muscle_group: 'shoulders', equipment: 'cable', how_to: 'x', is_custom: true, archived: false }], { onConflict: 'id' });
  const q = await plan(fresh.ctx, mkJson());
  assert.ok(!rowsOf(q.ops, 'exercises').some((r) => r.id === 'mine'));
  assert.equal(q.exerciseMap.get('strive:exercises:e4').id, 'mine');
});
test('exact names: a rename or create that would clash with another exercise keeps the library name / gets the suffix', async () => {
  const { ctx, backend } = await account();
  await backend.upsert('exercises', [
    { id: 'c1', name: 'Bicep curl (Dumbbell)', muscle_group: 'biceps', equipment: 'dumbbell', how_to: '', is_custom: true, archived: false },
    { id: 'c2', name: 'crünch', muscle_group: 'core', equipment: null, how_to: '', is_custom: true, archived: false },
  ], { onConflict: 'id' });
  const p = await plan(ctx, mkJson());
  const curl = await seedId(U, 'dumbbell-curl'), crunch = await seedId(U, 'strive:exercises:e8');
  assert.ok(!exRows(p.ops).some((r) => r.id === curl), 'no rename onto his own exercise');
  assert.equal(p.preview.mapping.find((m) => m.strive === 'Bicep curl (Dumbbell)').renamed, null);
  assert.equal(rowsOf(p.ops, 'exercises').find((r) => r.id === crunch).name, 'Crunch (Bodyweight)');
  for (const op of p.ops) for (const r of op.rows) assert.equal(validateGymRow(op.table, r), null);
  const res = await apply(ctx, p.ops);
  assert.deepEqual(res.failed, []);
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
});
test('exact names: unseeded library converges and re-runs emit nothing', async () => {
  const { ctx, backend } = await account({ seedLibrary: false });
  const r = await run(ctx, mkJson());
  assert.deepEqual(r.flushed.failed, []);
  assert.equal(backend.dump().exercises.find((e) => e.name === 'Seated cable row').id, await seedId(U, 'seated-cable-row'));
  assert.deepEqual((await plan(ctx, mkJson())).ops, []);
});
test('mappingLine: library with rename, library without, create', () => {
  assert.equal(S.mappingLine({ strive: 'Lat pulldown (Cable)', lifeos: 'Lat Pulldown', kind: 'alias', renamed: 'Lat pulldown (Cable)' }),
    'Lat pulldown (Cable) -> library: Lat Pulldown, renamed to "Lat pulldown (Cable)"');
  assert.equal(S.mappingLine({ strive: 'Face pull', lifeos: 'Rope Pulls', kind: 'match', renamed: null }), 'Face pull -> library: Rope Pulls');
  assert.equal(S.mappingLine({ strive: 'Crunch', lifeos: 'Crunch', kind: 'create', renamed: null }), 'Crunch -> create: Crunch');
});
