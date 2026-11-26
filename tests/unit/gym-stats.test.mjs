import test from 'node:test';
import assert from 'node:assert/strict';
import {
  epley, isWorking, beatsFront, insertFront, replayPrs, prsForDraft, bestPr,
  prefillSets, fmtKg, setLabel,
} from '../../js/lib/gym-stats.js';

let n = 0;
const S = (w, r, type = 'normal', extra = {}) => ({
  id: `s${++n}`, set_no: extra.no ?? n, reps: r, weight_kg: w, type,
  done_at: extra.at ?? `2026-01-01T10:${String(n % 60).padStart(2, '0')}:00Z`,
});
const ses = (startedAt, sets) => ({ workoutId: startedAt, startedAt, sets });
const flags = (m, sets) => sets.map((s) => m.get(s.id));

test('epley', () => {
  assert.equal(epley(100, 1), 100);
  assert.ok(Math.abs(epley(100, 5) - 100 * (1 + 5 / 30)) < 1e-9);
  assert.equal(epley(80, 12), 112);
  assert.equal(epley(80, 13), null);
  assert.equal(epley(80, 0), null);
});

test('isWorking / front helpers', () => {
  assert.equal(isWorking({ type: 'warmup', reps: 5 }), false);
  assert.equal(isWorking({ type: 'normal', reps: 0 }), false);
  assert.equal(isWorking({ type: 'dropset', reps: 1 }), true);
  assert.equal(beatsFront([{ w: 80, r: 8 }], { w: 80, r: 8 }), false);
  assert.equal(beatsFront([{ w: 80, r: 8 }], { w: 75, r: 10 }), true);
  assert.deepEqual(insertFront([{ w: 80, r: 8 }], { w: 82.5, r: 8 }), [{ w: 82.5, r: 8 }]);
});

test('replay A: s1 baseline, s2 flags', () => {
  const a = [S(80, 8), S(80, 8), S(80, 7)], b = [S(80, 8), S(82.5, 8), S(82.5, 8)];
  const m = replayPrs([ses('2026-02-01', b), ses('2026-01-01', a)]);
  assert.deepEqual(flags(m, a), [false, false, false]);
  assert.deepEqual(flags(m, b), [false, true, false]);
});
test('replay B/C/D/E/F/G', () => {
  let a = [S(80, 8)], b = [S(80, 9)];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [true]);
  b = [S(75, 10)];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [true]);
  a = [S(0, 10)]; b = [S(0, 12)];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [true]);
  b = [S(0, 10)];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [false]);
  a = [S(100, 5, 'warmup'), S(60, 5)]; b = [S(90, 5)];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [true]);
  a = [S(80, 8)]; b = [S(60, 12, 'dropset')];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [true]);
  a = [S(100, 5, 'warmup'), S(120, 3, 'warmup')]; b = [S(60, 5)];
  const m = replayPrs([ses('1', a), ses('2', b)]);
  assert.deepEqual(flags(m, b), [false]);
  assert.deepEqual(flags(m, a), [false, false]);
  a = [S(80, 8)]; b = [S(85, 4, 'failure')];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [true]);
});

test('prsForDraft', () => {
  const index = { exercises: { x: { front: [{ w: 80, r: 8 }], bestE1rm: 80 * (1 + 8 / 30) } } };
  const sets = [S(80, 8), S(82.5, 8), S(82.5, 8)];
  assert.deepEqual(flags(prsForDraft(index, { exerciseId: 'x', sets }), sets), [false, true, false]);
  assert.deepEqual(flags(prsForDraft(null, { exerciseId: 'x', sets }), sets), [false, false, false]);
  assert.deepEqual(flags(prsForDraft(index, { exerciseId: 'nope', sets }), sets), [false, false, false]);
});

test('bestPr', () => {
  const sets = [S(60, 12), S(82.5, 8)];
  const m = new Map(sets.map((s) => [s.id, true]));
  assert.deepEqual(bestPr(sets, m), { weight_kg: 82.5, reps: 8 });
  assert.equal(bestPr(sets, new Map()), null);
});

test('prefillSets', () => {
  const prev = [{ weight_kg: 80, reps: 8, type: 'normal' }, { weight_kg: 80, reps: 8, type: 'normal' },
    { weight_kg: 80, reps: 7, type: 'normal' }];
  const out = prefillSets({ prev, targetSets: 4, targetRepsMin: 8, equipment: 'barbell' });
  assert.deepEqual(out.map((o) => [o.kg, o.reps]), [[80, 8], [80, 8], [80, 7], [80, 7]]);
  const d = prefillSets({ prev: [{ weight_kg: 80, reps: 8, type: 'normal' }, { weight_kg: 60, reps: 12, type: 'dropset' }],
    targetSets: 2, targetRepsMin: 8, equipment: 'barbell' });
  assert.equal(d[1].type, 'dropset');
  assert.deepEqual(prefillSets({ prev: [], targetSets: 3, targetRepsMin: 8, equipment: 'barbell' }),
    Array(3).fill({ kg: null, reps: 8, type: 'normal' }));
  assert.equal(prefillSets({ prev: [], targetSets: 1, targetRepsMin: 8, equipment: 'bodyweight' })[0].kg, 0);
});

test('labels', () => {
  assert.equal(fmtKg(80), '80');
  assert.equal(fmtKg(82.5), '82.5');
  assert.equal(fmtKg(0), 'BW');
  assert.equal(setLabel({ weight_kg: 80, reps: 8 }), '80 × 8');
  assert.equal(setLabel(null), '—');
});

test('bestPr: null e1RM ties fall to weight, then set_no', () => {
  const sets = [S(60, 15, 'normal', { no: 3 }), S(70, 14, 'normal', { no: 2 }), S(70, 14, 'normal', { no: 1 })];
  const m = new Map(sets.map((s) => [s.id, true]));
  assert.equal(bestPr(sets, m).weight_kg, 70);
  const a = S('70.00', 14, 'normal', { no: 5 }), b = S(70, 14, 'normal', { no: 4 });
  const r = bestPr([a, b], new Map([[a.id, true], [b.id, true]]));
  assert.deepEqual(r, { weight_kg: 70, reps: 14 });
  const c = S(70, 14, 'normal', { no: 2 }), d = S(70, 13, 'normal', { no: 1 });
  assert.equal(bestPr([c, d], new Map([[c.id, true], [d.id, true]])).reps, 13, 'lower set_no wins the tie');
});

test('e1RM-only PR: dominated by a >12-rep set but beats best e1RM', () => {
  const a = [S(100, 15), S(60, 5)], b = [S(90, 8)];
  assert.deepEqual(flags(replayPrs([ses('1', a), ses('2', b)]), b), [true]);
  const index = { exercises: { x: { front: [{ w: 100, r: 15 }, { w: 60, r: 5 }], bestE1rm: 60 * (1 + 5 / 30) } } };
  assert.equal(beatsFront(index.exercises.x.front, { w: 90, r: 8 }), false);
  assert.deepEqual(flags(prsForDraft(index, { exerciseId: 'x', sets: b }), b), [true]);
});
