// Demo data for the in-memory (no-login) mode. Rows mirror the Postgres columns.
import { addDays, parseDateKey, isoWeekday, weekStart } from '../lib/dates.js';
import { DEFAULT_RITUALS } from '../lib/rituals.js';
import { GYM_EXERCISES } from './gym-seed.js';

const uuid = () => crypto.randomUUID();
const at = (dateKey, hh, mm = 0) => {
  const d = parseDateKey(dateKey);
  d.setHours(hh, mm, 0, 0);
  return d;
};

const U = 'demo-user';
const UPPER = [['Bench Press', 3, 5, 8, 60], ['Barbell Row', 3, 6, 10, 55], ['Overhead Press', 3, 5, 8, 40], ['Lat Pulldown', 3, 8, 12, 50], ['Lateral Raise', 3, 10, 15, 8], ['Triceps Pushdown', 3, 10, 15, 25]];
const LOWER = [['Back Squat', 4, 5, 8, 80], ['Romanian Deadlift', 3, 6, 10, 70], ['Leg Press', 3, 8, 12, 140], ['Lying Leg Curl', 3, 10, 12, 35], ['Standing Calf Raise', 3, 10, 15, 60]];

function demoGym(todayKey, gymHabitId) {
  const exercises = GYM_EXERCISES.map((e) => ({
    id: uuid(), user_id: U, name: e.name, muscle_group: e.muscle_group, equipment: e.equipment,
    how_to: e.name === 'Lateral Raise' ? 'Exécution : poulie à hauteur de visage, coudes légèrement fléchis.\nNe pas balancer le buste.' : e.how_to,
    is_custom: false, archived: false,
  }));
  const exId = (name) => exercises.find((e) => e.name === name).id;
  const routines = [{ id: uuid(), user_id: U, name: 'Upper', sort: 0, archived: false }, { id: uuid(), user_id: U, name: 'Lower', sort: 1, archived: false }];
  const defs = { Upper: UPPER, Lower: LOWER };
  const routine_items = [];
  for (const r of routines) {
    defs[r.name].forEach(([name, sets, min, max], position) => routine_items.push({
      id: uuid(), user_id: U, routine_id: r.id, exercise_id: exId(name), position, target_sets: sets, target_reps_min: min, target_reps_max: max,
    }));
  }
  const schedule_slots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    id: uuid(), user_id: U, weekday, routine_id: [routines[0].id, routines[1].id, null, routines[0].id, routines[1].id, null, null][weekday - 1],
  }));

  const workouts = [];
  const workout_exercises = [];
  const sets = [];
  let dropDone = false;
  let warmDone = false;
  const build = (w, list, startHour, progress) => {
    const start = at(w.day, startHour);
    w.started_at = start.toISOString();
    w.ended_at = new Date(start.getTime() + 62 * 60000).toISOString();
    workouts.push(w);
    list.forEach(([name, n, min, , base], position) => {
      const we = { id: uuid(), user_id: U, workout_id: w.id, exercise_id: exId(name), position, note: '' };
      workout_exercises.push(we);
      const count = 3 + ((position + progress) % 2);
      for (let i = 0; i < count; i++) {
        let type = 'normal';
        if (!warmDone && position === 0 && i === 0 && progress === 2) { type = 'warmup'; warmDone = true; }
        else if (!dropDone && position === 1 && i === count - 1 && progress === 3) { type = 'dropset'; dropDone = true; }
        const weight = type === 'warmup' ? base * 0.5 : base + progress * 2.5;
        sets.push({
          id: uuid(), user_id: U, workout_exercise_id: we.id, set_no: i + 1, reps: min + (i % 2), weight_kg: type === 'dropset' ? weight * 0.8 : weight,
          type, done_at: new Date(start.getTime() + (position * 10 + i * 3 + 2) * 60000).toISOString(),
        });
      }
    });
  };
  [-20, -18, -13, -11, -6, -4].forEach((off, i) => {
    const upper = i % 2 === 0;
    const r = routines[upper ? 0 : 1];
    build({ id: uuid(), user_id: U, routine_id: r.id, name: r.name, day: addDays(todayKey, off), duration_known: true, note: '', imported: false, source_ref: null },
      defs[r.name], 18, i);
  });
  build({ id: uuid(), user_id: U, routine_id: null, name: 'Upper', day: addDays(todayKey, -45), duration_known: true, note: '', imported: true, source_ref: 'demo:1' },
    UPPER.slice(0, 1), 18, 0);

  return { exercises, routines, routine_items, schedule_slots, workouts, workout_exercises, sets };
}

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

  const gymData = demoGym(todayKey, gym.id);

  return {
    settings: [{ id: uuid(), user_id: 'demo-user', water_target_l: 2.5, weekly_pages: 200, timezone: null, current_book_id: null, gym_seeded_at: created_at, gym_habit_id: gym.id }],
    habits, habit_logs, rituals, ritual_logs: [], events, sleep, water, books: [book], daily, reviews: [], ...gymData,
  };
}
