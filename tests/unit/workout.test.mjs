import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKg, parseReps, formatClock, workoutDay, durationMinutes, displayDuration, displayMinutes,
  MAX_KNOWN_MIN, finishPlan, validateEndTime, isStaleWorkout, staleEnd } from '../../js/lib/workout.js';

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

test('parseKg', () => {
  assert.equal(parseKg('82,5'), 82.5);
  assert.equal(parseKg('82.5'), 82.5);
  assert.equal(parseKg(' 80 '), 80);
  assert.equal(parseKg(''), null);
  assert.equal(parseKg('-1'), null);
  assert.equal(parseKg('1000'), 1000);
  assert.equal(parseKg('1000.01'), null);
  assert.equal(parseKg('82,25'), 82.25);
  assert.equal(parseKg('abc'), null);
  assert.equal(parseKg('8..5'), null);
});

test('parseReps', () => {
  assert.equal(parseReps('8'), 8);
  assert.equal(parseReps('0'), 0);
  assert.equal(parseReps('8,5'), null);
  assert.equal(parseReps(''), null);
  assert.equal(parseReps('1001'), null);
});

test('formatClock', () => {
  assert.equal(formatClock(2538000), '00:42:18');
  assert.equal(formatClock(3840000), '01:04:00');
  assert.equal(formatClock(36000000), '10:00:00');
  assert.equal(formatClock(-5000), '00:00:00');
});

test('workoutDay is device-local', () => {
  assert.equal(workoutDay(new Date(2026, 10, 24, 23, 30).toISOString()), '2026-11-24');
  assert.equal(workoutDay(new Date(2026, 10, 25, 0, 30).toISOString()), '2026-11-25');
  const want = process.env.TZ === 'Pacific/Auckland' ? '2026-06-22' : '2026-06-21';
  assert.equal(workoutDay('2026-06-21T16:44:17.000Z'), want);
  assert.doesNotThrow(() => workoutDay(new Date(2026, 2, 29, 2, 30).toISOString()));
  assert.equal(workoutDay(new Date(2026, 2, 29, 2, 30).toISOString()), '2026-03-29');
});

const wk = (min, extra = {}) => ({ started_at: '2026-11-24T08:00:00.000Z', ended_at: iso(Date.parse('2026-11-24T08:00:00.000Z') + min * MIN), ...extra });

test('durations', () => {
  assert.equal(MAX_KNOWN_MIN, 240);
  assert.equal(durationMinutes(wk(58)), 58);
  assert.equal(durationMinutes({ started_at: wk(1).started_at }), null);
  assert.equal(durationMinutes(wk(58, { duration_known: false })), null);
  assert.equal(displayDuration(wk(58)), '58 min');
  assert.equal(displayDuration(wk(64)), '1h04');
  assert.equal(displayDuration(wk(241)), '—');
  assert.equal(displayDuration(wk(58, { duration_known: false })), '—');
  assert.equal(displayDuration({ started_at: wk(1).started_at }), '—');
});

test('displayMinutes (planned-row minutes)', () => {
  assert.equal(displayMinutes(58), '58 min');
  assert.equal(displayMinutes(64), '1h04');
  assert.equal(displayMinutes(240), '4h00');
  assert.equal(displayMinutes(241), '—');
  assert.equal(displayMinutes(null), '—');
});

test('finishPlan', () => {
  const now = Date.parse('2026-11-24T10:00:00.000Z');
  const startedAt = iso(now - 60 * MIN);
  assert.deepEqual(finishPlan({ startedAt, lastTickAt: null, now: iso(now), tickedCount: 0 }), { kind: 'empty' });
  assert.deepEqual(finishPlan({ startedAt, lastTickAt: iso(now - 10 * MIN), now: iso(now), tickedCount: 5 }),
    { kind: 'normal', end: iso(now) });
  const t = now - 45 * MIN;
  assert.deepEqual(finishPlan({ startedAt, lastTickAt: iso(t), now: iso(now), tickedCount: 5 }),
    { kind: 'guarded', end: iso(t + 5 * MIN), alt: iso(now) });
  const long = iso(now - (4 * 60 + 1) * MIN);
  assert.deepEqual(finishPlan({ startedAt: long, lastTickAt: iso(now - 2 * MIN), now: iso(now), tickedCount: 5 }),
    { kind: 'guarded', end: iso(now), alt: iso(now) });
});

test('validateEndTime', () => {
  const now = Date.parse('2026-11-24T10:00:00.000Z');
  const ctx = { startedAt: iso(now - 60 * MIN), lastTickAt: iso(now - 30 * MIN), now: iso(now) };
  assert.equal(validateEndTime(iso(now - 90 * MIN), ctx), 'before-start');
  assert.equal(validateEndTime(iso(now - 40 * MIN), ctx), 'before-last-set');
  assert.equal(validateEndTime(iso(now + MIN), ctx), 'in-future');
  assert.equal(validateEndTime(iso(now - 10 * MIN), ctx), null);
});

test('isStaleWorkout / staleEnd', () => {
  const now = Date.parse('2026-11-24T20:00:00.000Z');
  const H = 60 * MIN;
  assert.equal(isStaleWorkout({ startedAt: iso(now - 6 * H - MIN), lastTickAt: null, now: iso(now) }), true);
  assert.equal(isStaleWorkout({ startedAt: iso(now - 5 * H - 59 * MIN), lastTickAt: null, now: iso(now) }), false);
  assert.equal(isStaleWorkout({ startedAt: iso(now - 9 * H), lastTickAt: iso(now - 10 * MIN), now: iso(now) }), false);
  assert.equal(isStaleWorkout({ startedAt: iso(now - 9 * H), lastTickAt: iso(now - 6 * H - MIN), now: iso(now) }), true);
  assert.equal(staleEnd({ startedAt: iso(now - 9 * H), lastTickAt: iso(now - 8 * H) }), iso(now - 8 * H + 5 * MIN));
  assert.equal(staleEnd({ startedAt: iso(now - 9 * H), lastTickAt: null }), iso(now - 9 * H));
});

// ---- review round 1 ----
const H = 60 * MIN;
const N = Date.parse('2026-11-24T10:00:00.000Z');
const fp = (startAgo, tickAgo, tickedCount = 5) => finishPlan({
  startedAt: iso(N - startAgo), lastTickAt: tickAgo == null ? null : iso(N - tickAgo), now: iso(N), tickedCount });

test('finishPlan: >4h elapsed with a stale-ish tick ends at lastTick+5min, alt now', () => {
  assert.deepEqual(fp(4 * H + MIN, 20 * MIN), { kind: 'guarded', end: iso(N - 15 * MIN), alt: iso(N) });
});

test('finishPlan boundaries', () => {
  assert.equal(fp(H, 30 * MIN).kind, 'normal');
  assert.equal(fp(H, 31 * MIN).kind, 'guarded');
  assert.equal(fp(4 * H, 2 * MIN).kind, 'normal');
  assert.equal(fp(4 * H + MIN, 2 * MIN).kind, 'guarded');
  assert.deepEqual(fp(H, null), { kind: 'normal', end: iso(N) });
  assert.deepEqual(fp(4 * H + MIN, null), { kind: 'guarded', end: iso(N), alt: iso(N) });
});

test('finishPlan clamps end to >= lastTickAt (future tick)', () => {
  const r = finishPlan({ startedAt: iso(N - 5 * H), lastTickAt: iso(N + 10 * MIN), now: iso(N), tickedCount: 3 });
  assert.equal(r.kind, 'guarded');
  assert.equal(r.end, iso(N + 10 * MIN));
});

test('validateEndTime equality is valid; unparseable is invalid', () => {
  const ctx = { startedAt: iso(N - 60 * MIN), lastTickAt: iso(N - 30 * MIN), now: iso(N) };
  assert.equal(validateEndTime(ctx.lastTickAt, ctx), null);
  assert.equal(validateEndTime(iso(N), ctx), null);
  assert.equal(validateEndTime(ctx.startedAt, { ...ctx, lastTickAt: null }), null);
  assert.equal(validateEndTime('nope', ctx), 'invalid');
  assert.equal(validateEndTime('', ctx), 'invalid');
});

test('isStaleWorkout exactly 6h is not stale', () => {
  assert.equal(isStaleWorkout({ startedAt: iso(N - 6 * H), lastTickAt: null, now: iso(N) }), false);
});

test('displayMinutes edge cases', () => {
  assert.equal(displayMinutes(59.6), '1h00');
  assert.equal(displayMinutes(59.4), '59 min');
  assert.equal(displayMinutes(-3), '—');
  assert.equal(displayMinutes(NaN), '—');
  assert.equal(displayMinutes(Infinity), '—');
});

test('formatClock edge cases', () => {
  assert.equal(formatClock(NaN), '00:00:00');
  assert.equal(formatClock(Infinity), '00:00:00');
  assert.equal(formatClock(59999), '00:00:59');
});

test('parse extras', () => {
  assert.equal(parseReps('1000'), 1000); // brief range is 0..1000 inclusive
  assert.equal(parseReps('-1'), null);
  assert.equal(parseReps('abc'), null);
  assert.equal(parseReps('08'), 8);
  assert.equal(parseKg('0'), 0);
});

import { endDurationKnown } from '../../js/lib/workout.js';
test('endDurationKnown: 240 min is known, 241 is not, negative/invalid is not', () => {
  const s = new Date(2026, 10, 24, 10, 0, 0).getTime();
  const at = (min) => new Date(s + min * 60000).toISOString();
  const start = new Date(s).toISOString();
  assert.equal(endDurationKnown(start, at(240)), true);
  assert.equal(endDurationKnown(start, at(241)), false);
  assert.equal(endDurationKnown(start, at(0)), true);
  assert.equal(endDurationKnown(start, at(-1)), false);
  assert.equal(endDurationKnown(start, 'junk'), false);
});
