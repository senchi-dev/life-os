import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseBackend, BackendError } from '../../js/data/backend-supabase.js';

function fakeClient(result) {
  const calls = [];
  const qb = (name) => {
    const q = { name, steps: [] };
    calls.push(q);
    const p = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(typeof result === 'function' ? result(q) : result).then(res, rej);
        return (...args) => { q.steps.push([prop, ...args]); return p; };
      },
    });
    return p;
  };
  return { calls, from: (t) => { const q = qb(t); return { select: (...a) => q.select(...a), upsert: (...a) => q.upsert(...a), delete: (...a) => q.delete(...a) }; } };
}

test('select maps filters', async () => {
  const c = fakeClient({ data: [{ id: 1 }], error: null });
  const b = createSupabaseBackend(c);
  const rows = await b.select('water', { eq: { a: 1 }, gte: { at: 'x' }, lte: { at: 'y' }, order: ['at', false] });
  assert.deepEqual(rows, [{ id: 1 }]);
  const steps = c.calls[0].steps.map(s => s[0]);
  assert.deepEqual(steps, ['select', 'match', 'gte', 'lte', 'order']);
  assert.deepEqual(c.calls[0].steps.at(-1), ['order', 'at', { ascending: false }]);
});

test('upsert and remove', async () => {
  const c = fakeClient({ data: null, error: null });
  const b = createSupabaseBackend(c);
  await b.upsert('daily', { date: 'd' }, { onConflict: 'user_id,date', ignoreDuplicates: true });
  assert.deepEqual(c.calls[0].steps[0], ['upsert', [{ date: 'd' }], { onConflict: 'user_id,date', ignoreDuplicates: true }]);
  await b.remove('water', { eq: { id: 'a' } });
  assert.deepEqual(c.calls[1].steps.map(s => s[0]), ['delete', 'match']);
});

test('errors become BackendError with kind', async () => {
  const b = createSupabaseBackend(fakeClient({ data: null, error: { message: 'boom', code: '23514' } }));
  await assert.rejects(b.upsert('t', { a: 1 }), (e) => e instanceof BackendError && e.kind === 'server');
  const b2 = createSupabaseBackend(fakeClient({ data: null, error: { message: 'x' }, status: 401 }));
  await assert.rejects(b2.select('t'), (e) => e.kind === 'auth');
  const b3 = createSupabaseBackend(fakeClient(() => { throw new TypeError('Load failed'); }));
  await assert.rejects(b3.select('t'), (e) => e.kind === 'network');
});

test('select maps range to supabase .range(from, to) last', async () => {
  const c = fakeClient({ data: [], error: null });
  await createSupabaseBackend(c).select('water', { order: ['id', true], range: [1000, 1999] });
  assert.deepEqual(c.calls[0].steps.map((s) => s[0]), ['select', 'match', 'order', 'range']);
  assert.deepEqual(c.calls[0].steps.at(-1), ['range', 1000, 1999]);
});

test('select maps in and is filters', async () => {
  const c = fakeClient({ data: [{ id: 1 }], error: null });
  const b = createSupabaseBackend(c);
  await b.select('sets', { in: { workout_exercise_id: ['a', 'b'] } });
  assert.deepEqual(c.calls[0].steps.find((s) => s[0] === 'in'), ['in', 'workout_exercise_id', ['a', 'b']]);
  await b.select('workouts', { is: { ended_at: null } });
  assert.deepEqual(c.calls[1].steps.find((s) => s[0] === 'is'), ['is', 'ended_at', null]);
});

test('select with an empty in list makes no request', async () => {
  const c = fakeClient({ data: [{ id: 1 }], error: null });
  assert.deepEqual(await createSupabaseBackend(c).select('sets', { in: { workout_exercise_id: [] } }), []);
  assert.equal(c.calls.length, 0);
});

test('select chunks an in list at 50 ids per request and merges the results', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `id${String(i).padStart(3, '0')}`);
  const c = fakeClient((q) => ({ data: q.steps.find((s) => s[0] === 'in')[2].map((id) => ({ id })), error: null }));
  const rows = await createSupabaseBackend(c).select('sets', { in: { id: ids }, order: ['id', true] });
  assert.equal(c.calls.length, 3);
  assert.deepEqual(c.calls.map((q) => q.steps.find((s) => s[0] === 'in')[2].length), [50, 50, 20]);
  assert.deepEqual(rows.map((r) => r.id), ids);
});
