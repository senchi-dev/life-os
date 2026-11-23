// In-memory Backend mimicking the Postgres/PostgREST behaviour the app relies on.
const clone = (v) => structuredClone(v);

export function createMemoryBackend(seed = {}, userId = 'demo-user') {
  const tables = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map(clone);
  const tbl = (t) => (tables[t] ??= []);
  const matches = (row, eq = {}) => Object.entries(eq).every(([k, v]) => row[k] === v);

  return {
    async select(table, q = {}) {
      let rows = tbl(table).filter((r) => matches(r, q.eq));
      for (const [k, v] of Object.entries(q.gte ?? {})) rows = rows.filter((r) => r[k] >= v);
      for (const [k, v] of Object.entries(q.lte ?? {})) rows = rows.filter((r) => r[k] <= v);
      if (q.order) {
        const [col, asc] = q.order;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      return rows.map(clone);
    },
    async upsert(table, rows, opts = {}) {
      const keys = (opts.onConflict ?? 'id').split(',').map((s) => s.trim());
      const list = tbl(table);
      const now = new Date().toISOString();
      for (const input of Array.isArray(rows) ? rows : [rows]) {
        const row = clone(input);
        row.user_id ??= userId;
        const existing = list.find((r) => keys.every((k) => row[k] !== undefined && r[k] === row[k]));
        if (existing) {
          if (opts.ignoreDuplicates) continue;
          for (const [k, v] of Object.entries(row)) if (v !== undefined && k !== 'id' && k !== 'created_at') existing[k] = v;
          existing.updated_at = now;
        } else {
          list.push({ ...row, id: row.id ?? crypto.randomUUID(), created_at: row.created_at ?? now, updated_at: row.updated_at ?? now });
        }
      }
    },
    async remove(table, q) {
      tables[table] = tbl(table).filter((r) => !matches(r, q.eq));
    },
    dump() {
      return clone(tables);
    },
  };
}
