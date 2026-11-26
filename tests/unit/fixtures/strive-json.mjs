// Synthetic Strive data only (never the real backup). mkRaw = SQLite rows as in the backup; mkJson = the normalised
// 'lifeos-strive-1' JSON built from it. Reused by the in-app import tests (Task 20).
import { normaliseStrive } from '../../../js/lib/strive-import.js';

export const T1 = 1782060257;                       // 2026-06-21T16:44:17Z (Paris 18:44 same day, Auckland 04:44 next day)
export const T2 = Date.UTC(2026, 6, 14, 12, 0, 0) / 1000; // 2026-07-14 12:00:00 UTC, back-filled
export const T3 = Date.UTC(2026, 10, 22, 9, 0, 0) / 1000;
export const FR_NOTE = 'Exécution : poulie à hauteur de visage\nNe pas balancer le buste.';

const ex = (id, name_en, category, body_parts) => ({ id, name_en, name_fr: null, category, body_parts, secondary_body_parts: '', deleted_at: null });
const setRow = (log, entry, exercise, order, reps, weight, type = 'none') => ({
  id: `${entry}-s${order}`, routine_exercise_set_id: null, routine_log_id: log, exercise_id: exercise, routine_exercise_log_id: entry,
  order, reps, weight, type, timer: null, is_weight_unit_metric: 1, is_distance_unit_metric: 1,
});
const entry = (id, log, exercise, order) => ({ id, routine_id: null, created_at: 0, routine_exercise_id: null, routine_log_id: log, exercise_id: exercise, order });
const tset = (id, routine, rex, exercise, order, reps) => ({ id, routine_id: routine, routine_exercise_id: rex, exercise_id: exercise, order, reps, reps_min: null, reps_max: null, type: 'none', is_weight_unit_metric: 1 });

export function mkRaw(o = {}) {
  const raw = {
    routine_logs: [
      { id: 'log-1', name: 'Upper Force', routine_id: 'r1', created_at: T1 + 71 * 60, started_at: T1, ended_at: T1 + 71 * 60 },
      { id: 'log-2', name: 'Lower', routine_id: 'r2', created_at: T2 - 86400, started_at: T2, ended_at: T2 + 60 * 60 },
      { id: 'log-3', name: 'Upper Force', routine_id: 'r1', created_at: T3 + 896 * 60, started_at: T3, ended_at: T3 + 896 * 60 },
    ],
    routine_exercise_logs: [
      entry('rel-1', 'log-1', 'e1', 0), entry('rel-2', 'log-1', 'e3', 1), entry('rel-3', 'log-1', 'e4', 2),
      entry('rel-4', 'log-2', 'e5', 0), entry('rel-5', 'log-2', 'e6', 1),
      entry('rel-6', 'log-3', 'e1', 0), entry('rel-7', 'log-3', 'e2', 1), entry('rel-8', 'log-3', 'e8', 2),
    ],
    routine_exercise_set_logs: [
      setRow('log-1', 'rel-1', 'e1', 0, 10, 40), setRow('log-1', 'rel-1', 'e1', 1, 9, 40), setRow('log-1', 'rel-1', 'e1', 2, 8, 40),
      setRow('log-1', 'rel-2', 'e3', 0, 12, 14), setRow('log-1', 'rel-2', 'e3', 1, 10, 14),
      setRow('log-1', 'rel-3', 'e4', 0, 15, 20), setRow('log-1', 'rel-3', 'e4', 1, 15, 20),
      setRow('log-2', 'rel-4', 'e5', 0, 12, 100), setRow('log-2', 'rel-4', 'e5', 1, 10, 100),
      setRow('log-2', 'rel-5', 'e6', 0, 15, 10), setRow('log-2', 'rel-5', 'e6', 1, 15, 10),
      setRow('log-3', 'rel-6', 'e1', 0, 10, 42.5), setRow('log-3', 'rel-6', 'e1', 1, 9, 42.5), setRow('log-3', 'rel-6', 'e1', 2, 8, 42.5),
      setRow('log-3', 'rel-7', 'e2', 0, 12, 50), setRow('log-3', 'rel-7', 'e2', 1, 10, 50, 'dropset'),
      setRow('log-3', 'rel-8', 'e8', 0, 20, null), setRow('log-3', 'rel-8', 'e8', 1, 20, null),
    ],
    routines: [
      { id: 'r1', name: 'Upper Force', description: '', deleted_at: null, created_at: 100 },
      { id: 'r2', name: 'Lower', description: '', deleted_at: null, created_at: 200 },
      { id: 'r3', name: 'Old plan', description: '', deleted_at: 300, created_at: 50 },
    ],
    routine_exercises: [
      { id: 're-1', routine_id: 'r1', exercise_id: 'e1', order: 0 }, { id: 're-2', routine_id: 'r1', exercise_id: 'e2', order: 1 },
      { id: 're-3', routine_id: 'r1', exercise_id: 'e3', order: 2 }, { id: 're-4', routine_id: 'r2', exercise_id: 'e5', order: 0 },
      { id: 're-5', routine_id: 'r3', exercise_id: 'e9', order: 0 },
    ],
    routine_exercise_sets: [
      tset('t1', 'r1', 're-1', 'e1', 0, 6), tset('t2', 'r1', 're-1', 'e1', 1, 8), tset('t3', 'r1', 're-1', 'e1', 2, 10),
      tset('t4', 'r1', 're-2', 'e2', 0, null), tset('t5', 'r1', 're-2', 'e2', 1, null), tset('t6', 'r1', 're-2', 'e2', 2, null),
      tset('t7', 'r1', 're-3', 'e3', 0, 10), tset('t8', 'r1', 're-3', 'e3', 1, 12),
      tset('t9', 'r2', 're-4', 'e5', 0, null), tset('t10', 'r2', 're-4', 'e5', 1, null), tset('t11', 'r2', 're-4', 'e5', 2, null),
      tset('t12', 'r3', 're-5', 'e9', 0, 5),
    ],
    exercises: [
      ex('e1', 'Incline Bench Press (Dumbbell)', 'dumbell', 'chest'), ex('e2', 'Seated cable row', 'cable', 'lats'),
      ex('e3', 'Bicep curl (Dumbbell)', 'dumbell', 'biceps'), ex('e4', 'Face pull', 'cable', 'rearDelts,traps'),
      ex('e5', 'Leg press (Machine)', 'machine', 'quads,glutes'), ex('e6', 'Lateral raise (Machine)', 'machine', 'sideDelts'),
      ex('e8', 'Crunch', 'reps', 'core'), ex('e9', 'Zottman curl', 'dumbell', 'biceps'), ex('e10', 'Never used', 'barbell', 'chest'),
    ],
    routine_exercise_notes: [
      { id: 'n1', owner_id: 'e4', type: 'exercise', note: FR_NOTE, created_at: 1 },
      { id: 'n2', owner_id: 'rel-1', type: 'log', note: 'Felt strong', created_at: 2 },
    ],
  };
  return Object.assign(raw, o);
}

export const mkJson = (overrides = {}) => Object.assign(normaliseStrive(mkRaw()), overrides);

// A session on `day` (device-local noon-ish UTC, so TZ never moves it) logging one set of Face Pull; for re-import tests.
export function extraSession(n, isoStart, { exerciseRef = 'strive:exercises:e4' } = {}) {
  return {
    ref: `strive:routine_logs:extra-${n}`, name: 'Upper Force', routine_ref: 'strive:routines:r1', started_at: isoStart, ended_at: isoStart,
    duration_known: false, note: '',
    exercises: [{ ref: `strive:routine_exercise_logs:extra-${n}-e`, exercise_ref: exerciseRef, position: 0,
      sets: [{ ref: `strive:routine_exercise_set_logs:extra-${n}-s`, set_no: 1, reps: 12, weight_kg: 22.5, type: 'normal', done_at: isoStart }] }],
  };
}
