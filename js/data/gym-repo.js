// Gym writes and paged reads. Every write is validated, then outbox.enqueue(op) and a non-awaited flush.
import { GYM_PAGE, IMPORT_BATCH } from './tables.js';
import { validateGymRow, GymValidationError } from '../lib/gym-validate.js';
import { normalizeGymRow, kick, saveSettings } from './repo.js';
import { GYM_EXERCISES } from './gym-seed.js';
import { seedId } from '../lib/ids.js';

const IN_PAGE_IDS = 50; // ids per `in` query: matches the backend chunk, so paging by range stays exact
const CONCURRENCY = 4;

export const upsertRows = (table, rows, { ignoreDuplicates = false } = {}) => ({
  kind: 'upsert', table, rows, onConflict: 'id', ...(ignoreDuplicates ? { ignoreDuplicates: true } : {}),
});
export const removeRow = (table, id) => ({ kind: 'remove', table, eq: { id } });
export function batchUpserts(table, rows, { size = IMPORT_BATCH, ignoreDuplicates } = {}) {
  const ops = [];
  for (let i = 0; i < rows.length; i += size) ops.push(upsertRows(table, rows.slice(i, i + size), { ignoreDuplicates }));
  return ops;
}

// All-or-nothing validation, then FIFO enqueue. A queue failure rejects; the flush itself is fire-and-forget.
export async function enqueueGym(ctx, ops) {
  for (const op of ops) {
    if (op.kind !== 'upsert') continue;
    for (const row of Array.isArray(op.rows) ? op.rows : [op.rows]) {
      const reason = validateGymRow(op.table, row);
      if (reason) throw new GymValidationError(op.table, reason);
    }
  }
  for (const op of ops) await ctx.outbox.enqueue(op);
  kick(ctx);
}

async function pagedSelect(ctx, table, q, pageSize) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const page = await ctx.backend.select(table, { ...q, order: ['id', true], range: [from, from + pageSize - 1] });
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

// Rows of `table` whose `col` is in `ids`, in chunks of 50 ids (a few at a time), each chunk paged by id.
async function pagedIn(ctx, table, col, ids, pageSize) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += IN_PAGE_IDS) chunks.push(ids.slice(i, i + IN_PAGE_IDS));
  const results = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      results[i] = await pagedSelect(ctx, table, { in: { [col]: chunks[i] } }, pageSize);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return results.flat();
}

const fix = (t, rows) => rows.map((r) => normalizeGymRow(t, r));

async function childrenOf(ctx, workouts, pageSize) {
  const workoutExercises = await pagedIn(ctx, 'workout_exercises', 'workout_id', workouts.map((w) => w.id), pageSize);
  const sets = await pagedIn(ctx, 'sets', 'workout_exercise_id', workoutExercises.map((x) => x.id), pageSize);
  return { workouts: fix('workouts', workouts), workoutExercises: fix('workout_exercises', workoutExercises), sets: fix('sets', sets) };
}

export async function fetchFinishedHistory(ctx, { pageSize = GYM_PAGE } = {}) {
  const all = await pagedSelect(ctx, 'workouts', {}, pageSize);
  return childrenOf(ctx, all.filter((w) => w.ended_at != null), pageSize);
}

export async function fetchWorkoutsByIds(ctx, ids, { pageSize = GYM_PAGE } = {}) {
  return childrenOf(ctx, await pagedIn(ctx, 'workouts', 'id', ids, pageSize), pageSize);
}

export async function fetchSetsFor(ctx, weIds, { pageSize = GYM_PAGE } = {}) {
  return fix('sets', await pagedIn(ctx, 'sets', 'workout_exercise_id', weIds, pageSize));
}

// What the Strive import must not redo: imported source refs, days that already have a native workout, and for each
// imported workout how many entries and sets it has, so a half-applied import is detected and completed (A1).
export async function fetchImportState(ctx, { pageSize = GYM_PAGE } = {}) {
  const importedRefs = new Set();
  const nativeDays = new Set();
  const imported = [];
  for (const w of await pagedSelect(ctx, 'workouts', {}, pageSize)) {
    if (w.imported && w.source_ref) { importedRefs.add(w.source_ref); imported.push(w); }
    else if (!w.imported && w.day) nativeDays.add(w.day);
  }
  const childCounts = new Map(imported.map((w) => [w.source_ref, { entries: 0, sets: 0 }]));
  if (imported.length) {
    const refOfWorkout = new Map(imported.map((w) => [w.id, w.source_ref]));
    const entries = await pagedIn(ctx, 'workout_exercises', 'workout_id', imported.map((w) => w.id), pageSize);
    const refOfEntry = new Map();
    for (const e of entries) { refOfEntry.set(e.id, refOfWorkout.get(e.workout_id)); childCounts.get(refOfWorkout.get(e.workout_id)).entries++; }
    for (const s of await pagedIn(ctx, 'sets', 'workout_exercise_id', entries.map((e) => e.id), pageSize)) childCounts.get(refOfEntry.get(s.workout_exercise_id)).sets++;
  }
  return { importedRefs, nativeDays, childCounts };
}

// Library seeding. Gated on settings.gym_seeded_at, so deleting a seeded exercise never recreates it.
export const needsGymSeed = (snapshot) => !!snapshot && !!snapshot.settings && snapshot.settings.gym_seeded_at == null;

// Seed rows use deterministic ids (seedId) + ignoreDuplicates: two devices seeding at once converge on one set.
// Names already in the snapshot (e.g. a custom 'bench press') are skipped, case-insensitively.
export async function ensureGymDefaults(ctx, snapshot) {
  const userId = snapshot.settings.user_id;
  const have = new Set((snapshot.exercises ?? []).map((e) => String(e.name).trim().toLowerCase()));
  const rows = [];
  for (const e of GYM_EXERCISES) {
    if (have.has(e.name.toLowerCase())) continue;
    rows.push({ id: await seedId(userId, e.key), name: e.name, muscle_group: e.muscle_group, equipment: e.equipment, how_to: e.how_to, is_custom: false, archived: false });
  }
  if (rows.length) await enqueueGym(ctx, batchUpserts('exercises', rows, { ignoreDuplicates: true }));
  const habit = (snapshot.habits ?? []).find((h) => String(h.name).trim().toLowerCase() === 'gym');
  await saveSettings(ctx, { gym_seeded_at: new Date().toISOString(), gym_habit_id: habit?.id ?? null });
}
