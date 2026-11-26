// Workout helpers: input parsing, session clock, duration display, finish/stale guards. Pure.
import { localDateKey } from './dates.js';
import { formatDuration } from './health.js';

export const MAX_KNOWN_MIN = 240;
const MIN = 60000;
const HOUR = 60 * MIN;

export function parseKg(input) {
  const s = String(input ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const x = Math.round(Number(s) * 100) / 100;
  return x >= 0 && x <= 1000 ? x : null;
}

export function parseReps(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const x = Number(s);
  return x <= 1000 ? x : null;
}

export function formatClock(ms) {
  const t = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / 1000) : 0;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

export function workoutDay(startedAtIso) {
  return localDateKey(new Date(startedAtIso));
}

export function durationMinutes(w) {
  if (!w?.ended_at || w.duration_known === false) return null;
  return (Date.parse(w.ended_at) - Date.parse(w.started_at)) / MIN;
}

// One definition for planned/done row minutes: '—' when unknown or implausible (> 4 h).
export function displayMinutes(min) {
  if (min == null || !Number.isFinite(min) || min < 0) return '—';
  const r = Math.round(min);
  if (r > MAX_KNOWN_MIN) return '—';
  return r < 60 ? `${r} min` : formatDuration(r);
}

export function displayDuration(w) {
  return displayMinutes(durationMinutes(w));
}

const ms = (iso) => Date.parse(iso);

export function finishPlan({ startedAt, lastTickAt, now, tickedCount }) {
  if (!tickedCount) return { kind: 'empty' };
  const n = ms(now);
  const tick = lastTickAt ? ms(lastTickAt) : null;
  const gapOld = tick != null && n - tick > 30 * MIN;
  const tooLong = n - ms(startedAt) > 4 * HOUR;
  if (!gapOld && !tooLong) return { kind: 'normal', end: now };
  // Guarded: end at the last ticked set + 5 min (never before it, never after now); alt = now.
  const end = tick == null ? now : new Date(Math.max(tick, Math.min(n, tick + 5 * MIN))).toISOString();
  return { kind: 'guarded', end, alt: now };
}

export function validateEndTime(endIso, { startedAt, lastTickAt, now }) {
  const e = ms(endIso);
  if (!Number.isFinite(e)) return 'invalid';
  if (e < ms(startedAt)) return 'before-start';
  if (lastTickAt && e < ms(lastTickAt)) return 'before-last-set';
  if (e > ms(now)) return 'in-future';
  return null;
}

// Stale = no activity (start or last ticked set) for more than 6 h (amendment A11).
export function isStaleWorkout({ startedAt, lastTickAt, now }) {
  const last = Math.max(ms(startedAt), lastTickAt ? ms(lastTickAt) : 0);
  return ms(now) - last > 6 * HOUR;
}

export function staleEnd({ startedAt, lastTickAt }) {
  return lastTickAt ? new Date(ms(lastTickAt) + 5 * MIN).toISOString() : startedAt;
}

// A stored duration is only trusted when end >= start and the span is at most MAX_KNOWN_MIN.
export function endDurationKnown(startIso, endIso) {
  const min = (Date.parse(endIso) - Date.parse(startIso)) / MIN;
  return Number.isFinite(min) && min >= 0 && min <= MAX_KNOWN_MIN;
}
