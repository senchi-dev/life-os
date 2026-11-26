// In-memory Backend mimicking the Postgres/PostgREST behaviour the app relies on.
const clone = (v) => structuredClone(v);

// Unique keys of the gym tables (004 migration); `where` marks a partial index.
const UNIQUES = {
  exercises: [{ cols: ['user_id', 'name'] }],
  routines: [{ cols: ['user_id', 'name'] }],
  schedule_slots: [{ cols: ['user_id', 'weekday'] }],
  workouts: [
    { cols: ['user_id'], where: (r) => r.ended_at == null },
    { cols: ['user_id', 'source_ref'], where: (r) => r.source_ref != null },
  ],
};
// [child table, fk column] per parent table.
const CASCADE = {
  workouts: [['workout_exercises', 'workout_id']],
  workout_exercises: [['sets', 'workout_exercise_id']],
  routines: [['routine_items', 'routine_id']],
};
const SET_NULL = { routines: [['schedule_slots', 'routine_id'], ['workouts', 'routine_id']] };
const RESTRICT = { exercises: [['routine_items', 'exercise_id'], ['workout_exercises', 'exercise_id']] };

const pgError = (code, message) => Object.assign(new Error(message), { code });
function checkUnique(table, list, cand, self) {
  for (const u of UNIQUES[table] ?? []) {
    if (u.where && !u.where(cand)) continue;
    if (list.some((r) => r !== self && (!u.where || u.where(r)) && u.cols.every((c) => r[c] === cand[c]))) {
      throw pgError('23505', `duplicate key value violates unique constraint on ${table} (${u.cols.join(',')})`);
    }
  }
}

export function createMemoryBackend(seed = {}, userId = 'demo-user') {
  const tables = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map(clone);
  const tbl = (t) => (tables[t] ??= []);
  const matches = (row, eq = {}) => Object.entries(eq).every(([k, v]) => row[k] === v);

  function removeWhere(table, pred, top) {
    const doomed = tbl(table).filter(pred);
    if (!doomed.length) return;
    const ids = new Set(doomed.map((r) => r.id));
    if (top) {
      for (const [child, col] of RESTRICT[table] ?? []) {
        if (tbl(child).some((r) => ids.has(r[col]))) throw pgError('23503', `${table} is still referenced from ${child}`);
      }
    }
    tables[table] = tbl(table).filter((r) => !ids.has(r.id));
    for (const [child, col] of SET_NULL[table] ?? []) for (const r of tbl(child)) if (ids.has(r[col])) r[col] = null;
    for (const [child, col] of CASCADE[table] ?? []) removeWhere(child, (r) => ids.has(r[col]), false);
  }

  return {
    async select(table, q = {}) {
      let rows = tbl(table).filter((r) => matches(r, q.eq));
      for (const [k, v] of Object.entries(q.in ?? {})) rows = rows.filter((r) => v.includes(r[k]));
      for (const [k, v] of Object.entries(q.is ?? {})) rows = rows.filter((r) => (v === null ? r[k] == null : r[k] === v));
      for (const [k, v] of Object.entries(q.gte ?? {})) rows = rows.filter((r) => r[k] >= v);
      for (const [k, v] of Object.entries(q.lte ?? {})) rows = rows.filter((r) => r[k] <= v);
      if (q.order) {
        const [col, asc] = q.order;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      return rows.map(clone);
    },
    async upsert(table, rows, opts = {}) {
      const keys = (opts.onConflict ?? 'id').split(',').map((s) => s.trim());
      // Stage on a copy so a violating batch applies nothing (one Postgres statement is atomic).
      const list = tbl(table).map((r) => ({ ...r }));
      const now = new Date().toISOString();
      for (const input of Array.isArray(rows) ? rows : [rows]) {
        const row = clone(input);
        row.user_id ??= userId;
        const existing = list.find((r) => keys.every((k) => row[k] !== undefined && r[k] === row[k]));
        if (existing) {
          if (opts.ignoreDuplicates) continue;
          const next = { ...existing };
          for (const [k, v] of Object.entries(row)) if (v !== undefined && k !== 'id' && k !== 'created_at') next[k] = v;
          next.updated_at = now;
          checkUnique(table, list, next, existing);
          Object.assign(existing, next);
        } else {
          const next = { ...row, id: row.id ?? crypto.randomUUID(), created_at: row.created_at ?? now, updated_at: row.updated_at ?? now };
          checkUnique(table, list, next, null);
          list.push(next);
        }
      }
      tables[table] = list;
    },
    async remove(table, q) {
      removeWhere(table, (r) => matches(r, q.eq), true);
    },
    dump() {
      return clone(tables);
    },
  };
}
