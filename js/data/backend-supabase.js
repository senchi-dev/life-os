// Supabase-backed Backend. Never logs row contents.
export class BackendError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'BackendError';
    this.kind = kind;
    this.cause = cause;
  }
}

export function classifyError(err) {
  const status = err?.status;
  const code = err?.code;
  const msg = String(err?.message ?? '');
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return 'auth';
  // A Postgres SQLSTATE (e.g. 42501 RLS rejection) is a server-side rejection, even on HTTP 403.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return 'server';
  if (status === 403 || /jwt|expired|refresh token/i.test(msg)) return 'auth';
  if (err instanceof TypeError || /fetch|network|load failed/i.test(msg)) return 'network';
  return 'server';
}

function fail(err, status) {
  const plain = err instanceof Error || typeof err !== 'object'
    ? err
    : { message: err.message, code: err.code, status: err.status ?? status };
  return new BackendError(classifyError(plain), String(err?.message ?? 'Backend error'), err);
}

async function run(builder) {
  let res;
  try {
    res = await builder;
  } catch (e) {
    throw fail(e);
  }
  if (res?.error) throw fail(res.error, res.status);
  return res?.data ?? null;
}

export function createSupabaseBackend(client) {
  return {
    async select(table, q = {}) {
      let b = client.from(table).select('*').match(q.eq ?? {});
      for (const [k, v] of Object.entries(q.gte ?? {})) b = b.gte(k, v);
      for (const [k, v] of Object.entries(q.lte ?? {})) b = b.lte(k, v);
      if (q.order) b = b.order(q.order[0], { ascending: q.order[1] });
      if (q.range) b = b.range(q.range[0], q.range[1]);
      return (await run(b)) ?? [];
    },
    async upsert(table, rows, opts = {}) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return;
      const o = {};
      if (opts.onConflict) o.onConflict = opts.onConflict;
      if (opts.ignoreDuplicates) o.ignoreDuplicates = true;
      await run(client.from(table).upsert(list, o));
    },
    async remove(table, q) {
      await run(client.from(table).delete().match(q.eq));
    },
  };
}
