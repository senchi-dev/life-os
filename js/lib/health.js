import { localDateKey, parseDateKey, addDays, hhmmToMinutes, minutesToHHMM } from './dates.js';

export const LITER_CHIPS = [0.25, 0.5, 1];
export const PAGE_CHIPS = [10, 20, 30];
export const DEFAULT_WATER_TARGET_L = 2.5;
export const DEFAULT_WEEKLY_PAGES = 200;

const HALF_DAY_MS = 12 * 3600 * 1000;
const NOON = 720;
const toDate = (v) => (v instanceof Date ? v : new Date(v));
const sinceNoon = (min) => (((min - NOON) % 1440) + 1440) % 1440;
const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function nightOf(bedAt) {
  return localDateKey(new Date(bedAt.getTime() - HALF_DAY_MS));
}

function atTime(dateKey, hhmm) {
  const d = parseDateKey(dateKey);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

export function buildSleep({ wakeDateKey, bed, wake }) {
  const bedKey = hhmmToMinutes(bed) >= NOON ? addDays(wakeDateKey, -1) : wakeDateKey;
  const bed_at = atTime(bedKey, bed);
  const wake_at = atTime(wakeDateKey, wake);
  const minutes = Math.round((wake_at - bed_at) / 60000);
  if (!(minutes > 0 && minutes <= 1200)) throw new RangeError('Sleep duration must be between 1 minute and 20 hours');
  return { night_of: nightOf(bed_at), bed_at, wake_at, minutes };
}

export function defaultTimes(history) {
  const last = history.slice(-7);
  if (!last.length) return { bed: '23:30', wake: '07:30' };
  const bed = median(last.map((r) => sinceNoon(minuteOfDay(toDate(r.bed_at)))));
  const wake = median(last.map((r) => minuteOfDay(toDate(r.wake_at))));
  return { bed: minutesToHHMM(bed + NOON), wake: minutesToHHMM(wake) };
}

export function sleepStats(rows) {
  if (!rows.length) return { nights: 0, avgMinutes: null, avgBed: null, bedSpreadMin: null };
  const durations = rows.map((r) => (toDate(r.wake_at) - toDate(r.bed_at)) / 60000);
  const beds = rows.map((r) => sinceNoon(minuteOfDay(toDate(r.bed_at))));
  const avgBed = mean(beds);
  const spread = Math.sqrt(mean(beds.map((b) => (b - avgBed) ** 2)));
  return {
    nights: rows.length,
    avgMinutes: Math.round(mean(durations)),
    avgBed: minutesToHHMM(avgBed + NOON),
    bedSpreadMin: Math.round(spread),
  };
}

export function formatDuration(min) {
  const t = Math.round(min);
  return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}`;
}

export function parseLiters(input) {
  const s = String(input ?? '').trim().replace(',', '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const x = Math.round(Number(s) * 100) / 100;
  return x > 0 && x <= 3 ? x : null;
}

export function waterTotalsByDay(rows) {
  const m = new Map();
  for (const { at, liters } of rows) {
    const k = localDateKey(toDate(at));
    m.set(k, Math.round(((m.get(k) ?? 0) + liters) * 100) / 100);
  }
  return m;
}
