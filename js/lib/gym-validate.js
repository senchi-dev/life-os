// Client-side mirror of the CHECK constraints in supabase/migrations/004_gym.sql.
// validateGymRow returns null (valid, or not a gym table) or a short reason naming the column.
import { GYM_TABLES } from '../data/tables.js';
import { MUSCLE_GROUPS, EQUIPMENT } from '../data/gym-seed.js';

export class GymValidationError extends Error {
  constructor(table, reason) { super(`${table}: ${reason}`); this.name = 'GymValidationError'; this.table = table; this.reason = reason; }
}

const isStr = (v) => typeof v === 'string';
const len = (v, lo, hi) => isStr(v) && v.length >= lo && v.length <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const bool = (v) => typeof v === 'boolean';
const has = (r, k) => r[k] !== undefined;
const ts = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

const CHECKS = {
  exercises: (r) =>
    !len(r.name, 1, 60) ? 'name' :
    !MUSCLE_GROUPS.includes(r.muscle_group) ? 'muscle_group' :
    (r.equipment != null && !EQUIPMENT.includes(r.equipment)) ? 'equipment' :
    !len(r.how_to, 0, 2000) ? 'how_to' :
    !bool(r.is_custom) ? 'is_custom' : null,
  routines: (r) => !len(r.name, 1, 40) ? 'name' : null,
  routine_items: (r) =>
    !int(r.position, -32768, 32767) ? 'position' :
    !int(r.target_sets, 1, 10) ? 'target_sets' :
    !int(r.target_reps_min, 1, 100) ? 'target_reps_min' :
    !int(r.target_reps_max, 1, 100) || r.target_reps_max < r.target_reps_min ? 'target_reps_max' : null,
  schedule_slots: (r) => !int(r.weekday, 1, 7) ? 'weekday' : null,
  workouts: (r) =>
    !len(r.name, 1, 40) ? 'name' :
    !(isStr(r.day) && /^\d{4}-\d{2}-\d{2}$/.test(r.day)) ? 'day' :
    !ts(r.started_at) ? 'started_at' :
    (r.ended_at != null && (!ts(r.ended_at) || Date.parse(r.ended_at) < Date.parse(r.started_at))) ? 'ended_at' :
    (has(r, 'note') && !len(r.note, 0, 2000)) ? 'note' :
    (r.source_ref != null && !len(r.source_ref, 1, 80)) ? 'source_ref' :
    (r.imported && r.source_ref == null) ? 'source_ref' :
    (r.imported && r.ended_at == null) ? 'ended_at' : null,
  workout_exercises: (r) =>
    !int(r.position, -32768, 32767) ? 'position' :
    (has(r, 'note') && !len(r.note, 0, 500)) ? 'note' : null,
  sets: (r) =>
    !int(r.set_no, 1, 50) ? 'set_no' :
    !int(r.reps, 0, 1000) ? 'reps' :
    !(typeof r.weight_kg === 'number' && Number.isFinite(r.weight_kg) && r.weight_kg >= 0 && r.weight_kg <= 1000 && Math.abs(r.weight_kg * 100 - Math.round(r.weight_kg * 100)) < 1e-6) ? 'weight_kg' :
    !['normal', 'warmup', 'dropset', 'failure'].includes(r.type) ? 'type' :
    !ts(r.done_at) ? 'done_at' : null,
};

export function validateGymRow(table, row) {
  if (!GYM_TABLES.includes(table)) return null;
  if (!row || typeof row !== 'object') return 'row';
  if (!isStr(row.id) || !row.id) return 'id';
  return CHECKS[table](row);
}
