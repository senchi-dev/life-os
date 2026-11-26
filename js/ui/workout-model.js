// Pure view-model and helpers for the workout screen. No DOM, no clock, no storage.
import { prevFor } from '../lib/gym-index.js';
import { setLabel, fmtKg } from '../lib/gym-stats.js';
import { parseKg, parseReps, formatClock, isStaleWorkout, staleEnd, finishPlan, validateEndTime, endDurationKnown, displayMinutes } from '../lib/workout.js';
import { draftSummary, untickedWithValues } from '../lib/workout-draft.js';
import { localDateKey, nowHHMM, formatDayLabel } from '../lib/dates.js';
import { validateExerciseForm, HOW_TO_MAX } from '../lib/gym-forms.js';

export const LONG_PRESS_MS = 500;

export const TYPE_OPTIONS = Object.freeze([
  { type: 'normal', name: 'Normal', code: null },
  { type: 'warmup', name: 'Warm-up', code: 'W' },
  { type: 'dropset', name: 'Drop set', code: 'D' },
  { type: 'failure', name: 'Failure', code: 'F' },
].map(Object.freeze));

export const typeCode = (type) => TYPE_OPTIONS.find((o) => o.type === type)?.code ?? null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function targetOf(items, exerciseId) {
  const it = (items ?? []).find((i) => i.exercise_id === exerciseId);
  if (!it || !it.target_sets) return null;
  const lo = it.target_reps_min;
  const hi = it.target_reps_max;
  if (lo == null) return `${it.target_sets} sets`;
  return hi == null || hi === lo ? `${it.target_sets} × ${lo}` : `${it.target_sets} × ${lo}–${hi}`;
}

function lastTopOf(index, exerciseId) {
  const sessions = index?.exercises?.[exerciseId]?.sessions;
  const top = sessions?.length ? sessions[sessions.length - 1].top : null;
  return top ? `${fmtKg(top.w)} × ${top.r}` : null;
}

// Rows of one exercise. Warm-ups sit outside the prev alignment (prev holds working sets only), and the visible
// number counts only normal sets, so W, 1, 2, D, F reads like the plan.
function rowsOf(we, prev) {
  let working = 0;
  let normal = 0;
  return we.sets.map((s) => {
    const code = typeCode(s.type);
    let prevText = '—';
    if (s.type !== 'warmup') { prevText = setLabel(prev[working]); working += 1; }
    if (s.type === 'normal') normal += 1;
    return {
      setId: s.id,
      type: s.type,
      label: code ?? String(normal),
      prev: prevText,
      kg: s.kg,
      reps: s.reps,
      done: !!s.done,
      faint: !s.done && !s.edited && (s.kg != null || s.reps != null),
      canTick: s.kg != null && s.reps != null,
    };
  });
}

export function workoutViewModel(draft, { exercisesById = {}, index = null, routineItems = [], activeWeId = null } = {}) {
  const ordered = draft.exercises.slice().sort((a, b) => a.position - b.position);
  const sum = draftSummary(draft);
  const pinned = ordered.find((e) => e.id === activeWeId);
  const firstOpen = ordered.find((e) => e.sets.some((s) => !s.done));
  const active = pinned ?? firstOpen ?? ordered[ordered.length - 1] ?? null;
  return {
    title: draft.workout.name || 'Workout',
    startedAt: draft.workout.started_at,
    summary: `${plural(sum.sets, 'set')} · ${sum.exercisesDone} of ${sum.exercisesTotal} ${sum.exercisesTotal === 1 ? 'exercise' : 'exercises'}`,
    exercises: ordered.map((we) => {
      const ex = exercisesById?.[we.exercise_id];
      return {
        weId: we.id,
        exerciseId: we.exercise_id,
        name: ex?.name ?? 'Exercise',
        howTo: ex?.how_to ?? '',
        note: we.note ?? '',
        target: targetOf(routineItems, we.exercise_id),
        lastTop: lastTopOf(index, we.exercise_id),
        expanded: active === we,
        rows: rowsOf(we, prevFor(index, we.exercise_id)),
      };
    }),
  };
}

// --- typed input ----------------------------------------------------------------------------------------------
// 'ok' (value to dispatch), 'empty' (clear the cell) or 'invalid' (leave the draft alone). A trailing "," or "." and a
// leading one are in-progress typing of a decimal and read as the number so far.
export function parseKgInput(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { kind: 'empty', value: null };
  const shaped = t.replace(/[.,]$/, '').replace(/^[.,]/, '0$&');
  const v = /^\d/.test(shaped) ? parseKg(shaped) : null;
  return v === null ? { kind: 'invalid', value: null } : { kind: 'ok', value: v };
}

export function parseRepsInput(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { kind: 'empty', value: null };
  const v = parseReps(t);
  return v === null ? { kind: 'invalid', value: null } : { kind: 'ok', value: v };
}

// --- remove flow ----------------------------------------------------------------------------------------------
// What a Remove tap does to the last set. A done set is only removed by a second tap on that same set.
export function removeStep(set, armedSetId) {
  if (!set) return 'none';
  if (!set.done) return 'remove';
  return armedSetId === set.id ? 'remove' : 'arm';
}

// --- set type picker ------------------------------------------------------------------------------------------
// hold: pointer held LONG_PRESS_MS. tap: a short pointer release (touch taps must not open it: they are scrolling
// or aiming at a neighbour; a mouse has no long-press habit). key: Enter/Space on the focused number.
export function opensTypePicker(kind, pointerType) {
  if (kind === 'hold' || kind === 'key') return true;
  if (kind === 'tap') return pointerType === 'mouse';
  return false;
}

// --- minibar --------------------------------------------------------------------------------------------------
export function minibarText(draft, nowMs) {
  if (!draft?.workout) return '';
  return `${draft.workout.name || 'Workout'} · ${formatClock(nowMs - Date.parse(draft.workout.started_at))}`;
}

// --- stale draft ----------------------------------------------------------------------------------------------
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// null while the workout is live; otherwise the blocking "still open" sheet content. Ending needs at least one ticked
// set (canEnd): an empty workout is only discarded.
export function staleSheetModel(draft, nowIso) {
  if (!draft?.workout) return null;
  const stale = isStaleWorkout({ startedAt: draft.workout.started_at, lastTickAt: draft.lastTickAt, now: nowIso });
  if (!stale) return null;
  const endIso = staleEnd({ startedAt: draft.workout.started_at, lastTickAt: draft.lastTickAt });
  const day = new Date(draft.workout.started_at);
  const weekday = WEEKDAYS[new Date(`${localDateKey(day)}T12:00:00`).getDay()];
  return {
    title: `Workout from ${weekday} still open`,
    endIso,
    endLabel: `End at ${nowHHMM(new Date(endIso))}`,
    canEnd: draftSummary(draft).sets > 0,
  };
}

// --- stale prompt decision ------------------------------------------------------------------------------------
// What the app should do about a stale draft right now: null (nothing), 'navigate' (go to #/workout, which shows the
// blocking sheet) or 'show' (already there). `ackedAt` is when the user chose Resume: it counts as activity, so Resume
// is not asked again until another 6 h pass. Never prompts without a draft.
export function needsStalePrompt({ draft, now, route, ackedAt = null }) {
  if (!draft?.workout) return null;
  const last = [draft.lastTickAt, ackedAt].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  if (!staleSheetModel({ ...draft, lastTickAt: last }, now)) return null;
  return route === 'workout' ? 'show' : 'navigate';
}

// Notice after discarding a workout whose Gym habit tick stays (the tick belongs to that day).
export function stillCheckedText(dayKey) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dayKey)) ? new Date(`${dayKey}T12:00:00`) : null;
  return `Gym is still checked for ${d && !Number.isNaN(d.getTime()) ? WEEKDAYS[d.getDay()] : 'that day'}.`;
}

// --- typing on a DONE set -------------------------------------------------------------------------------------
// A done set is already queued: every dispatched edit becomes an upsert. So edits wait for a pause (delay), a blur or
// Enter (flush), and a value equal to the draft's is never sent. flush() runs the dispatches synchronously (serial
// queue keeps order), so callers flush before tick/untick/remove/finish/navigation and no edit is lost.
export function createEditCommitter({ delay = 600, setTimer = setTimeout, clearTimer = clearTimeout, current, dispatch }) {
  const pending = new Map(); // key -> { value, meta, timer }
  const commit = (key) => {
    const p = pending.get(key);
    if (!p) return null;
    clearTimer(p.timer);
    pending.delete(key);
    if (p.value === current(key)) return null;
    return dispatch(key, p.value, p.meta);
  };
  return {
    input(key, value, meta) {
      const old = pending.get(key);
      if (old) clearTimer(old.timer);
      pending.set(key, { value, meta, timer: setTimer(() => { commit(key); }, delay) });
    },
    flush: () => Promise.all([...pending.keys()].map(commit)),
    cancel() { for (const p of pending.values()) clearTimer(p.timer); pending.clear(); },
    get size() { return pending.size; },
  };
}

// ====================================================================================================================
// Finish sheet, end time, notes, exercise menu (Task 18). All pure.
// ====================================================================================================================

// Same limits as the CHECK constraints mirrored in gym-validate.js (workouts.note 2000, workout_exercises.note 500).
export const SESSION_NOTE_MAX = 2000;
export const EXERCISE_NOTE_MAX = 500;

export const noteError = (text, max) => (String(text ?? '').length > max ? `Note is too long (max ${max} characters).` : null);

const toIso = (t) => (t instanceof Date ? t.toISOString() : new Date(t).toISOString());

// Duration text for a workout ending at endIso: '—' when unknown (over 4 h, or the end is not after the start).
export function finishDuration(startedAtIso, endIso) {
  if (!endDurationKnown(startedAtIso, endIso)) return '—';
  return displayMinutes((Date.parse(endIso) - Date.parse(startedAtIso)) / 60000);
}

export const prLineText = (l) => `${l.name} ${fmtKg(l.weight_kg)} × ${l.reps} · PR`;

// What the finish sheet shows. `empty`: nothing ticked, only Discard and Back. `guarded`: the session looks left open
// (last tick more than 30 min ago, or more than 4 h elapsed): the primary action ends it at the last set + 5 min.
export function finishSheetModel(draft, { now, prLines = [] } = {}) {
  const nowIso = toIso(now);
  const { sets } = draftSummary(draft);
  const unticked = untickedWithValues(draft);
  const prs = (prLines ?? []).map(prLineText);
  const startedAt = draft.workout.started_at;
  const plan = finishPlan({ startedAt, lastTickAt: draft.lastTickAt, now: nowIso, tickedCount: sets });
  if (plan.kind === 'empty') {
    return { kind: 'empty', duration: '—', sets: 0, prs: [], unticked,
      primary: { label: 'Discard (nothing logged)', end: null }, secondary: { label: 'Back', end: null } };
  }
  const base = { duration: finishDuration(startedAt, plan.end), sets, prs, unticked };
  if (plan.kind === 'normal') return { kind: 'normal', ...base, primary: { label: 'Save workout', end: plan.end } };
  const same = plan.end === plan.alt; // last set + 5 min would be in the future: both choices are "now"
  const out = { kind: 'guarded', ...base,
    primary: { label: same ? `End at ${nowHHMM(new Date(plan.end))}` : `End at ${nowHHMM(new Date(plan.end))} (last set + 5 min)`, end: plan.end } };
  if (!same) out.secondary = { label: 'End now', end: plan.alt };
  return out;
}

// "HH:MM" from a time input -> ISO. Local time only. The date is today, unless that moment is still in the future,
// then it is the day before (a session started 23:30 and ended 00:20, saved at 00:40, ends today; "23:50" read at 00:40
// ends yesterday). Among the two days, one inside [start, now] wins. If neither is, the validator must say why:
// a session that started today and a later time typed -> that time today (in-future); otherwise the latest day not in
// the future (usually before-start). null for anything but HH:MM.
export function endFromTimeInput(hhmm, now, startedAt) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const n = new Date(now);
  if (Number.isNaN(n.getTime())) return null;
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const day = (d) => new Date(n.getFullYear(), n.getMonth(), n.getDate() + d, hh, mm, 0, 0);
  const today = day(0);
  const past = [today, day(-1)].filter((c) => c.getTime() <= n.getTime());
  const inside = past.find((c) => Number.isNaN(start) || c.getTime() >= start);
  if (inside) return inside.toISOString();
  const startedToday = !Number.isNaN(start) && localDateKey(new Date(start)) === localDateKey(n);
  return (startedToday ? today : past[0]).toISOString();
}

const END_MESSAGES = Object.freeze({
  'before-start': 'The end time is before the workout started.',
  'before-last-set': 'The end time is before your last logged set.',
  'in-future': 'The end time is in the future.',
  invalid: 'Enter a valid end time, like 18:30.',
});
export const endTimeMessage = (code) => (code == null ? '' : END_MESSAGES[code] ?? END_MESSAGES.invalid);

// The end the sheet will save. Untouched, the planned end is kept to the second; edited, the HH:MM is read and checked.
export function resolveFinishEnd({ draft, now, planEnd, touched, hhmm }) {
  const nowIso = toIso(now);
  const startedAt = draft.workout.started_at;
  const end = touched ? endFromTimeInput(hhmm, nowIso, startedAt) : planEnd;
  if (!end) return { end: null, code: 'invalid' };
  return { end, code: validateEndTime(end, { startedAt, lastTickAt: draft.lastTickAt, now: nowIso }) };
}

// The prompt for sets that have a weight and reps but were never ticked. null when there are none.
export function untickedPrompt(n) {
  if (!(n > 0)) return null;
  return { text: `${n} unticked ${n === 1 ? 'set' : 'sets'}`, choices: [{ label: 'Log them', logUnticked: true }, { label: 'Discard', logUnticked: false }] };
}

export function habitCheckedText(dayKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dayKey)) ? `Gym checked for ${formatDayLabel(dayKey)}` : 'Gym checked';
}

// Overlays never stack: a stale prompt that arrives while the finish sheet is open closes it (the end time it showed
// is outdated), unless a finish is already being saved, then the prompt waits (the draft is about to go).
export function finishVsStale({ finishOpen, finishBusy }) {
  if (!finishOpen) return 'show';
  return finishBusy ? 'ignore' : 'close-finish';
}

// --- exercise menu --------------------------------------------------------------------------------------------
export function exerciseMenuModel(draft, weId) {
  const order = draft.exercises.slice().sort((a, b) => a.position - b.position);
  const i = order.findIndex((e) => e.id === weId);
  if (i < 0) return null;
  const hasDone = order[i].sets.some((s) => s.done);
  return { items: [
    { id: 'howto', label: 'Edit how-to', disabled: false },
    { id: 'replace', label: 'Replace exercise', disabled: hasDone, reason: hasDone ? 'Not available once a set is done.' : null },
    { id: 'up', label: 'Move up', disabled: i === 0, reason: i === 0 ? 'Already first.' : null },
    { id: 'down', label: 'Move down', disabled: i === order.length - 1, reason: i === order.length - 1 ? 'Already last.' : null },
    { id: 'remove', label: 'Remove exercise', disabled: false, danger: true },
  ] };
}

// The FULL exercises row with a new how-to (the write replaces the row, so nothing else may be dropped).
export function howToRow(ex, text) {
  if (!ex?.id) return { ok: false, error: 'Exercise not found' };
  const how = String(text ?? '');
  if (how.length > HOW_TO_MAX) return { ok: false, error: 'How-to too long' };
  return { ok: true, row: { id: ex.id, name: ex.name, muscle_group: ex.muscle_group, equipment: ex.equipment ?? null, how_to: how, is_custom: !!ex.is_custom, archived: !!ex.archived } };
}

// New custom exercise from the inline form (name + muscle group only).
export function customExerciseRow({ name, muscle_group }, existing, newId) {
  const r = validateExerciseForm({ name, muscle_group, equipment: '', how_to: '' }, existing, null);
  if (!r.ok) return r;
  return { ok: true, row: { id: newId(), ...r.row, is_custom: true, archived: false } };
}

// --- local snapshot after finish / discard ---------------------------------------------------------------------
// Today and Gym read the in-memory snapshot, and finishing must not wait for a network read: patch it here (the
// server copy arrives with the queued writes). The habit log keys on (habit_id, date), like the upsert.
export function applyFinishToSnapshot(snap, { workoutRow, habitLog }, newId) {
  snap.workouts = [...(snap.workouts ?? []).filter((w) => w.id !== workoutRow.id), workoutRow];
  if (habitLog) {
    const logs = (snap.habitLogs ?? []).filter((l) => !(l.habit_id === habitLog.habit_id && l.date === habitLog.date));
    snap.habitLogs = [...logs, { id: newId(), ...habitLog }];
  }
  if (snap.activeWorkout?.workout?.id === workoutRow.id) snap.activeWorkout = null;
}

export function applyDiscardToSnapshot(snap, workoutId) {
  snap.workouts = (snap.workouts ?? []).filter((w) => w.id !== workoutId);
  if (snap.activeWorkout?.workout?.id === workoutId) snap.activeWorkout = null;
}

// ====================================================================================================================
// Review round 1: sheet restore after a re-render, dismiss rules, finish guard.
// ====================================================================================================================

// What an open editor sheet leaves behind when a re-render closes it. null when nothing was typed (clean) or the
// sheet kind is unknown. `initial` is the text the sheet opened with.
export function sheetStash(s) {
  if (!s) return null;
  if (s.kind === 'howto' || s.kind === 'note') {
    return s.text === s.initial ? null : { kind: s.kind, weId: s.weId, text: s.text };
  }
  if (s.kind === 'picker') {
    const dirty = String(s.query ?? '').trim() !== '' || (s.view === 'new' && (!!s.name || !!s.muscle));
    return dirty ? { kind: 'picker', mode: s.mode, weId: s.weId ?? null, query: s.query ?? '', view: s.view ?? 'list', name: s.name ?? '', muscle: s.muscle ?? '' } : null;
  }
  return null;
}

// A stash is restored only while what it belongs to still exists (the exercise may have been removed meanwhile,
// and Replace is only possible while the exercise has no done sets).
export function shouldRestoreSheet(stash, draft, exercisesById = {}) {
  if (!stash || !draft) return false;
  const we = stash.weId ? draft.exercises.find((e) => e.id === stash.weId) : null;
  if (stash.kind === 'note') return !!we;
  if (stash.kind === 'howto') return !!we && !!exercisesById[we.exercise_id];
  if (stash.kind === 'picker') {
    if (stash.mode === 'replace') return !!we && !we.sets.some((s) => s.done);
    return stash.mode === 'add';
  }
  return false;
}

// Escape / backdrop on a sheet: ignored while saving; a dirty editor asks once more before discarding.
export function dismissStep({ busy, dirty, armed }) {
  if (busy) return 'ignore';
  if (dirty && !armed) return 'arm';
  return 'close';
}

export const canOpenFinish = ({ finishOpen = false, finishBusy = false, staleOpen = false, opening = false } = {}) =>
  !(finishOpen || finishBusy || staleOpen || opening);

// One async action at a time. setBusy(true/false) brackets every run (a failure re-enables), a second call while
// pending is ignored, `ignore(e)` marks errors that already showed their message.
export function createGuard({ setBusy = () => {}, onError = () => {}, ignore = () => false } = {}) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(fn) {
      if (busy) return false;
      busy = true;
      setBusy(true);
      try {
        await fn();
        return true;
      } catch (e) {
        if (!ignore(e)) onError(e);
        return false;
      } finally {
        busy = false;
        setBusy(false);
      }
    },
  };
}
