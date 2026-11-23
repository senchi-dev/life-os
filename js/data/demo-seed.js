// Demo data for the in-memory (no-login) mode. Rows mirror the Postgres columns.
import { addDays, parseDateKey, isoWeekday, weekStart } from '../lib/dates.js';
import { DEFAULT_RITUALS } from '../lib/rituals.js';

const uuid = () => crypto.randomUUID();
const at = (dateKey, hh, mm = 0) => {
  const d = parseDateKey(dateKey);
  d.setHours(hh, mm, 0, 0);
  return d;
};

export function demoSeed(todayKey) {
  const created_at = at(addDays(todayKey, -60), 9).toISOString();
  const mkHabit = (name, extra, sort) => ({ id: uuid(), name, weekdays: null, target_n: null, active: true, sort, created_at, ...extra });
  const gym = mkHabit('Gym', { schedule_kind: 'n_per_week', target_n: 4 }, 0);
  const read = mkHabit('Read', { schedule_kind: 'daily' }, 1);
  const phone = mkHabit('No phone in bed', { schedule_kind: 'daily' }, 2);
  const maths = mkHabit("Maths 30'", { schedule_kind: 'weekdays', weekdays: [1, 2, 3, 4, 5] }, 3);
  const habits = [gym, read, phone, maths];

  const habit_logs = [];
  const log = (h, date, status = 'done') => habit_logs.push({ id: uuid(), habit_id: h.id, date, status, created_at });
  for (let i = 21; i >= 1; i--) {
    const date = addDays(todayKey, -i);
    if ([1, 2, 4, 6].includes(isoWeekday(date))) log(gym, date);
    if (i > 2) log(read, date); // yesterday and the day before missed: the double miss
    if (i <= 3 || i % 6 !== 3) log(phone, date);
    if (isoWeekday(date) <= 5 && (i <= 3 || i % 5 !== 0)) log(maths, date);
  }

  const rituals = DEFAULT_RITUALS.map((r) => ({ id: uuid(), ...r, checklist: [...r.checklist] }));

  const ev = (offset, title, start, end, location = null) => ({
    id: uuid(), title, date: addDays(todayKey, offset), start_time: start, end_time: end, location,
  });
  const events = [
    ev(0, 'Rates desk', '09:30', '17:30', 'Office'),
    ev(0, 'Gym', '18:00', '19:00'),
    ev(1, 'Maths session', '19:30', '20:00'),
    ev(2, 'Call with mentor', '12:30', '13:00'),
    ev(4, 'Dinner', '20:00', null),
  ];

  const sleep = [];
  for (let i = 10; i >= 1; i--) {
    const night_of = addDays(todayKey, -i);
    const bed_at = at(night_of, 23, i % 3 === 0 ? 30 : 0);
    const wake_at = at(addDays(night_of, 1), 7, i % 2 ? 0 : 20);
    sleep.push({ id: uuid(), night_of, bed_at: bed_at.toISOString(), wake_at: wake_at.toISOString() });
  }

  const water = [{ id: uuid(), at: at(todayKey, 8, 30).toISOString(), liters: 1.5 }];

  const book = { id: uuid(), title: 'Investment Banking', author: 'Rosenbaum', total_pages: 550, started_on: addDays(todayKey, -30), finished_on: null };

  const lastWeek = addDays(weekStart(todayKey), -7);
  const daily = Array.from({ length: 7 }, (_, i) => ({
    id: uuid(), date: addDays(lastWeek, i), pages: [30, 20, 0, 30, 25, 40, 20][i], mood: [3, 4, 3, 4, 4, 5, 4][i], book_id: book.id,
  }));

  return {
    settings: [{ id: uuid(), user_id: 'demo-user', water_target_l: 2.5, weekly_pages: 200, timezone: null, current_book_id: null }],
    habits, habit_logs, rituals, ritual_logs: [], events, sleep, water, books: [book], daily, reviews: [],
  };
}
