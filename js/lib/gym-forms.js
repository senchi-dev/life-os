// Pure form logic for the exercise library and routine ordering. No DOM, no storage.
import { MUSCLE_GROUPS, EQUIPMENT } from '../data/gym-seed.js';
import { upsertRows, removeRow } from '../data/gym-repo.js';
import { seedId } from './ids.js';
import { gymTargetPatch } from './schedule.js';

// Same limits as the CHECK constraints mirrored in gym-validate.js (exercises.name 1..60, how_to <= 2000).
export const EXERCISE_NAME_MAX = 60;
export const HOW_TO_MAX = 2000;

// Accent- and case-insensitive key: 'Développé' and 'developpe' fold to the same text.
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function filterExercises(list, { query = '', muscle = null, includeArchived = false } = {}) {
  const q = fold(query).trim();
  return (Array.isArray(list) ? list : [])
    .filter((e) => (includeArchived || !e.archived)
      && (!muscle || e.muscle_group === muscle)
      && (!q || fold(e.name).includes(q)))
    .sort((a, b) => fold(a.name).localeCompare(fold(b.name)) || String(a.name).localeCompare(String(b.name)));
}

export function validateExerciseForm({ name, muscle_group, equipment, how_to } = {}, existing = [], selfId = null) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, error: 'Name required' };
  if (n.length > EXERCISE_NAME_MAX) return { ok: false, error: 'Name too long' };
  const key = fold(n);
  if ((existing ?? []).some((e) => e.id !== selfId && fold(String(e.name).trim()) === key)) return { ok: false, error: 'Name already used' };
  if (!MUSCLE_GROUPS.includes(muscle_group)) return { ok: false, error: 'Pick a muscle group' };
  const eq = equipment === '' || equipment == null ? null : equipment;
  if (eq !== null && !EQUIPMENT.includes(eq)) return { ok: false, error: 'Pick equipment' };
  const how = String(how_to ?? '');
  if (how.length > HOW_TO_MAX) return { ok: false, error: 'How-to too long' };
  return { ok: true, row: { name: n, muscle_group, equipment: eq, how_to: how } };
}

// Delete is only safe when nothing references the exercise. An index that is not loaded proves nothing: no delete.
export function canDeleteExercise(id, { routineItems, index, draft } = {}) {
  if (!index || !index.exercises) return false;
  if ((routineItems ?? []).some((i) => i.exercise_id === id)) return false;
  if (index.exercises[id]) return false;
  if ((draft?.exercises ?? []).some((e) => e.exercise_id === id)) return false;
  return true;
}

// Swap `id` with its neighbour (dir -1 up, +1 down) and rewrite positions 0..n-1. Pure.
export function moveItem(items, id, dir) {
  const list = [...(items ?? [])].sort((a, b) => a.position - b.position);
  const i = list.findIndex((x) => x.id === id);
  const j = i + (dir === 1 ? 1 : dir === -1 ? -1 : 0);
  if (i >= 0 && j >= 0 && j < list.length && j !== i) [list[i], list[j]] = [list[j], list[i]];
  return list.map((x, p) => ({ ...x, position: p }));
}

// ---- Routine editor and weekly schedule ----
// routines.name 1..40 (004 CHECK, mirrored in gym-validate.js).
export const ROUTINE_NAME_MAX = 40;

// Names are unique per user in the DB (archived ones included), so the duplicate check sees every routine.
export function validateRoutineForm({ name } = {}, routines = [], selfId = null) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, error: 'Name required' };
  if (n.length > ROUTINE_NAME_MAX) return { ok: false, error: 'Name too long' };
  const key = fold(n);
  if ((routines ?? []).some((r) => r.id !== selfId && fold(String(r.name).trim()) === key)) return { ok: false, error: 'Name already used' };
  return { ok: true, row: { name: n } };
}

// Whole numbers only: '8', ' 8 ' and 8 pass; '', '8.5', '1e1', NaN, null do not.
const wholeNumber = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return NaN;
};
const within = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

// Same bounds as the routine_items CHECKs: target_sets 1..10, reps 1..100, max >= min.
export function validateRoutineItem({ target_sets, target_reps_min, target_reps_max } = {}) {
  const sets = wholeNumber(target_sets);
  const min = wholeNumber(target_reps_min);
  const max = wholeNumber(target_reps_max);
  if (!within(sets, 1, 10)) return { ok: false, error: 'Sets: 1 to 10' };
  if (!within(min, 1, 100) || !within(max, 1, 100)) return { ok: false, error: 'Reps: 1 to 100' };
  if (max < min) return { ok: false, error: 'Max reps must be at least min' };
  return { ok: true, row: { target_sets: sets, target_reps_min: min, target_reps_max: max } };
}

// Ops in FK-safe order: the routine row, all its items in one upsert (positions rewritten 0..n-1), then one removal per
// dropped item. An empty routine is allowed (nextRoutineId and trainingCycle never look at items).
export function routineSaveOps({ routine, items = [], removedItemIds = [] } = {}) {
  const kept = [...(items ?? [])].sort((a, b) => a.position - b.position).map((i, position) => ({ ...i, position }));
  const keptIds = new Set(kept.map((i) => i.id));
  const ops = [upsertRows('routines', [{ ...routine }])];
  if (kept.length) ops.push(upsertRows('routine_items', kept));
  for (const id of new Set(removedItemIds ?? [])) if (!keptIds.has(id)) ops.push(removeRow('routine_items', id));
  return ops;
}

// One upsert of exactly 7 full rows (Mon..Sun) keyed by (user_id, weekday), then the Gym habit's target_n when it no
// longer matches the number of training days. Existing rows keep their ids and columns; new ones get seedId(userId,
// 'schedule:' + weekday) (amendment A4), so two devices writing a first schedule converge. Async because seedId is.
export async function scheduleSaveOps({ slots, existing = [], gymHabit = null, userId } = {}) {
  const list = Array.isArray(slots) ? slots : [];
  const days = new Set(list.map((s) => s?.weekday));
  if (list.length !== 7 || days.size !== 7 || ![1, 2, 3, 4, 5, 6, 7].every((d) => days.has(d))) {
    throw new RangeError('slots: need exactly 7 rows, weekdays 1 to 7');
  }
  const byDay = new Map((existing ?? []).map((r) => [r.weekday, r]));
  const rows = [];
  for (const s of [...list].sort((a, b) => a.weekday - b.weekday)) {
    const old = byDay.get(s.weekday);
    if (!old?.id && !userId) throw new TypeError('userId is required to seed new schedule slot ids');
    rows.push({ ...(old ?? {}), id: old?.id ?? await seedId(userId, `schedule:${s.weekday}`), weekday: s.weekday, routine_id: s.routine_id ?? null });
  }
  const ops = [{ ...upsertRows('schedule_slots', rows), onConflict: 'user_id,weekday' }];
  const patch = gymHabit ? gymTargetPatch(gymHabit, rows) : null;
  if (patch) ops.push(upsertRows('habits', [patch]));
  return ops;
}
