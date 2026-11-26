// Strive import: normalise a backup's tables, map its exercises, and build an idempotent, ordered op plan.
// Pure apart from seedId (WebCrypto). Shared by tools/import-strive.mjs and the in-app import. Never ships data.
import { seedId } from './ids.js';
import { GYM_EXERCISES } from '../data/gym-seed.js';
import { replayPrs } from './gym-stats.js';
import { defaultSlots, gymTargetPatch } from './schedule.js';
import { workoutDay } from './workout.js';
import { batchUpserts, upsertRows } from '../data/gym-repo.js';
import { fold } from './gym-forms.js';

export const STRIVE_FORMAT = 'lifeos-strive-1';

export class ImportError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'ImportError'; this.code = code; }
}

const MIN_KNOWN_S = 10 * 60;
const MAX_KNOWN_S = 240 * 60;
const SET_END_PAD_S = 120;

// Strive stores epoch SECONDS; a milliseconds value lands far outside 2020..2030 and is rejected.
export function toIso(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new ImportError('timestamp', `bad timestamp ${seconds}`);
  const d = new Date(seconds * 1000);
  const y = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || y < 2020 || y > 2030) throw new ImportError('timestamp', `timestamp out of range: ${seconds}`);
  return d.toISOString();
}

const plausible = (s) => s >= MIN_KNOWN_S && s <= MAX_KNOWN_S;

// Inputs and the comparisons are in seconds. Absurd durations are never imported: unknown = ended_at is started_at.
export function striveDuration({ started_at, ended_at, created_at, setTimes = [] }) {
  const unknown = { ended_at: toIso(started_at), duration_known: false };
  if (setTimes.length) {
    const end = Math.max(...setTimes) + SET_END_PAD_S;
    if (plausible(end - started_at)) return { ended_at: toIso(end), duration_known: true };
  }
  if (created_at < started_at) return unknown; // back-filled after the fact: its end is not a measurement
  if (plausible(ended_at - started_at)) return { ended_at: toIso(ended_at), duration_known: true };
  return unknown;
}

export const CATEGORY_EQUIPMENT = Object.freeze({
  dumbell: 'dumbbell', barbell: 'barbell', olympic: 'barbell', cable: 'cable', machine: 'machine', smith: 'machine',
  reps: 'bodyweight', weigtedBodyweight: 'bodyweight', assistedBodyweight: 'bodyweight',
});
export const BODY_PART_MUSCLE = Object.freeze({
  chest: 'chest', lats: 'back', traps: 'back', erectors: 'back',
  frontDelts: 'shoulders', sideDelts: 'shoulders', rearDelts: 'shoulders', neck: 'shoulders',
  biceps: 'biceps', triceps: 'triceps', forearms: 'forearms', quads: 'quads', hamstrings: 'hamstrings',
  glutes: 'glutes', adductors: 'glutes', calves: 'calves', core: 'core',
});
const equipmentOf = (category) => CATEGORY_EQUIPMENT[category] ?? 'other';
const muscleOf = (bodyParts) => BODY_PART_MUSCLE[bodyParts?.[0]] ?? 'core';

const create = (muscle_group, equipment) => ({ create: { muscle_group, equipment } });
// Keyed by lowercased, trimmed Strive name_en. A string is a library lift; { create } is a new exercise, named with the exact
// Strive name (only its muscle group and equipment come from here).
export const STRIVE_MAP = Object.freeze({
  'incline bench press (dumbbell)': 'Incline Dumbbell Press',
  'bench press (dumbbell)': 'Dumbbell Bench Press',
  'lateral raise (cable)': 'Cable Lateral Raise',
  'seated cable row': 'Seated Cable Row',
  'lat pulldown (cable)': 'Lat Pulldown',
  'seated overhead press (dumbbell)': 'Seated Dumbbell Shoulder Press',
  'bicep curl (dumbbell)': 'Dumbbell Curl',
  'overhead tricep extension (cable)': 'Overhead Cable Triceps Extension',
  'hack squat': 'Hack Squat',
  'leg extension': 'Leg Extension',
  'seated leg curl': 'Seated Leg Curl',
  'hip abduction': 'Hip Abduction',
  'shrug (dumbbell)': 'Dumbbell Shrug',
  'face pull': 'Face Pull',
  'chest fly (machine)': 'Pec Deck',
  'standing calf raise (dumbbell)': create('calves', 'dumbbell'),
  'cable push down - one arm': create('triceps', 'cable'),
  'cable push down': 'Triceps Pushdown',
  'single-arm dumbbell row': 'One-arm Dumbbell Row',
  'chest supported row': create('back', 'machine'),
  crunch: create('core', 'bodyweight'),
});

export function normName(s) {
  let equipment = null;
  let t = String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  t = t.replace(/\((dumbbell|cable|machine|barbell)\)/, (_, e) => { equipment = e; return ' '; });
  t = t.replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ');
  const words = t.split(/\s+/).filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return { name: words.join(' '), equipment };
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const lc = (s) => String(s ?? '').trim().toLowerCase();

const sameName = (a, b) => fold(String(a ?? '').trim()) === fold(String(b ?? '').trim()); // validateExerciseForm's duplicate rule

// A created exercise keeps the exact Strive name (trimmed). Only a clash with ANOTHER exercise (case- and accent-insensitive)
// falls back to the equipment suffix; ownId is the row this import itself created for that Strive exercise (not a clash).
export function mapExercise(striveEx, library, { ownId = null } = {}) {
  const key = lc(striveEx.name_en);
  const exact = String(striveEx.name_en ?? '').trim();
  const clash = (name) => [...library, ...GYM_EXERCISES].some((l) => (ownId == null || l.id !== ownId) && sameName(l.name, name));
  const named = (equipment) => (clash(exact) ? `${exact} (${cap(equipment)})` : exact).slice(0, 60);
  const find = (name) => library.find((l) => lc(l.name) === lc(name)) ?? GYM_EXERCISES.find((l) => lc(l.name) === lc(name));
  const alias = STRIVE_MAP[key];
  if (typeof alias === 'string') {
    const lift = find(alias);
    if (!lift) throw new ImportError('format', `alias target missing from the library: ${alias}`);
    return { kind: 'alias', name: lift.name, equipment: lift.equipment, muscle_group: lift.muscle_group };
  }
  if (alias) return { kind: 'create', name: named(alias.create.equipment), ...alias.create };
  const n = normName(striveEx.name_en);
  const equipment = n.equipment ?? equipmentOf(striveEx.category);
  for (const l of library) {
    const ln = normName(l.name);
    if (ln.name === n.name && (l.equipment ?? ln.equipment) === equipment) return { kind: 'match', name: l.name, equipment: l.equipment, muscle_group: l.muscle_group };
  }
  return { kind: 'create', name: named(equipment), equipment, muscle_group: muscleOf(striveEx.body_parts) };
}

// ---- normalisation of the backup's tables ----
const bodyParts = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean));
const byCol = (rows, col) => { const m = new Map(); for (const r of rows) { const k = r[col]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const byOrder = (a, b) => a.order - b.order;
const setType = (t) => {
  if (t === 'none') return 'normal';
  if (t === 'dropset') return 'dropset';
  throw new ImportError('set-type', `unsupported set type: ${t}`);
};

export function normaliseStrive(raw) {
  const { routine_logs, routine_exercise_logs, routine_exercise_set_logs, routines, routine_exercise_sets, exercises, routine_exercise_notes } = raw;
  const routineExercises = raw.routine_exercises;
  const entriesByLog = byCol(routine_exercise_logs, 'routine_log_id');
  const setsByEntry = byCol(routine_exercise_set_logs, 'routine_exercise_log_id');
  const entryToLog = new Map(routine_exercise_logs.map((e) => [e.id, e.routine_log_id]));
  const logIds = new Set(routine_logs.map((l) => l.id));

  const notes = [...routine_exercise_notes].sort((a, b) => a.created_at - b.created_at);
  const howTo = new Map();
  const logNote = new Map();
  for (const n of notes) {
    if (n.type === 'exercise') howTo.set(n.owner_id, n.note);
    else if (n.type === 'log') {
      const log = logIds.has(n.owner_id) ? n.owner_id : entryToLog.get(n.owner_id);
      if (log !== undefined) logNote.set(log, logNote.has(log) ? `${logNote.get(log)}\n${n.note}` : n.note);
    }
  }

  const live = routines.filter((r) => r.deleted_at == null).sort((a, b) => a.created_at - b.created_at);
  const used = new Set([...routine_exercise_logs.map((e) => e.exercise_id), ...howTo.keys()]);
  const liveIds = new Set(live.map((r) => r.id));
  for (const re of routineExercises) if (liveIds.has(re.routine_id)) used.add(re.exercise_id);
  const tsets = byCol(routine_exercise_sets, 'routine_exercise_id');

  const outRoutines = live.map((r) => ({
    ref: `strive:routines:${r.id}`, name: r.name,
    items: routineExercises.filter((re) => re.routine_id === r.id).sort(byOrder).map((re, position) => {
      const ts = tsets.get(re.id) ?? [];
      const reps = ts.map((t) => t.reps).filter((x) => x > 0);
      return {
        ref: `strive:routine_exercises:${re.id}`, exercise_ref: `strive:exercises:${re.exercise_id}`, position,
        sets: Math.min(10, Math.max(1, ts.length)),
        reps_min: reps.length ? Math.min(100, Math.min(...reps)) : 8, reps_max: reps.length ? Math.min(100, Math.max(...reps)) : 12,
      };
    }),
  }));

  const workouts = [...routine_logs].sort((a, b) => a.started_at - b.started_at).map((l) => {
    const entries = (entriesByLog.get(l.id) ?? []).slice().sort(byOrder);
    const dur = striveDuration({ started_at: l.started_at, ended_at: l.ended_at, created_at: l.created_at }); // the backup has no set times
    const started_at = toIso(l.started_at);
    return {
      ref: `strive:routine_logs:${l.id}`, name: l.name, routine_ref: l.routine_id ? `strive:routines:${l.routine_id}` : null,
      started_at, ended_at: dur.ended_at, duration_known: dur.duration_known, note: logNote.get(l.id) ?? '',
      exercises: entries.map((e, position) => ({
        ref: `strive:routine_exercise_logs:${e.id}`, exercise_ref: `strive:exercises:${e.exercise_id}`, position,
        sets: (setsByEntry.get(e.id) ?? []).slice().sort(byOrder).map((s) => {
          if (s.is_weight_unit_metric !== 1) throw new ImportError('unit', 'only metric (kg) sets can be imported');
          return {
            ref: `strive:routine_exercise_set_logs:${s.id}`, set_no: s.order + 1, reps: s.reps ?? 0,
            weight_kg: Math.round((s.weight ?? 0) * 100) / 100, type: setType(s.type), done_at: started_at,
          };
        }),
      })),
    };
  });

  return {
    format: STRIVE_FORMAT,
    counts: { sessions: routine_logs.length, entries: routine_exercise_logs.length, sets: routine_exercise_set_logs.length },
    exercises: exercises.filter((x) => used.has(x.id)).map((x) => ({
      ref: `strive:exercises:${x.id}`, name_en: String(x.name_en).trim(), body_parts: bodyParts(x.body_parts), category: x.category, how_to: howTo.get(x.id) ?? '',
    })),
    routines: outRoutines,
    workouts,
  };
}

// ---- the import plan ----
const seedByName = new Map(GYM_EXERCISES.map((e) => [lc(e.name), e]));
const seedRow = (e, id) => ({ id, name: e.name, muscle_group: e.muscle_group, equipment: e.equipment, how_to: e.how_to, is_custom: false, archived: false });

const MAX_NOTE = 2000; // gym-validate.js: exercises.how_to and workouts.note
function checkJson(json) {
  if (!json || json.format !== STRIVE_FORMAT) throw new ImportError('format', 'not a Life OS Strive export');
  const c = json.counts;
  const entries = (json.workouts ?? []).reduce((n, w) => n + w.exercises.length, 0);
  const sets = (json.workouts ?? []).reduce((n, w) => n + w.exercises.reduce((m, e) => m + e.sets.length, 0), 0);
  for (const x of json.exercises ?? []) if (String(x.how_to ?? '').length > MAX_NOTE) throw new ImportError('format', `how-to note too long (${x.how_to.length} > ${MAX_NOTE}): ${x.name_en}`);
  for (const w of json.workouts ?? []) if (String(w.note ?? '').length > MAX_NOTE) throw new ImportError('format', `session note too long (${w.note.length} > ${MAX_NOTE}): ${w.name}`);
  if (!c || c.sessions !== (json.workouts ?? []).length || c.entries !== entries || c.sets !== sets) throw new ImportError('counts', 'counts do not match the file contents');
}

// One preview line per Strive exercise, shared by the dry-run report and the in-app mapping table. Names only, never ids.
export function mappingLine(m) {
  const head = `${m.strive} -> ${m.kind === 'create' ? 'create' : 'library'}: ${m.lifeos}`;
  return m.renamed ? `${head}, renamed to "${m.renamed}"` : head;
}

export async function buildImportPlan({ json, snapshot, importState, userId, includeDuplicates = new Set() }) {
  checkJson(json);
  const snapEx = snapshot.exercises ?? [];
  const snapByName = new Map(snapEx.map((e) => [lc(e.name), e]));
  const library = [...snapEx, ...GYM_EXERCISES.filter((e) => !snapByName.has(lc(e.name)))];

  // exercises
  const exerciseMap = new Map();
  const idByName = new Map();
  const idById = new Map();
  const snapById = new Map(snapEx.map((e) => [e.id, e]));
  const seedById = new Map();
  for (const e of GYM_EXERCISES) seedById.set(await seedId(userId, e.key), e);
  // Names already in use: his rows, library seeds not yet in his account, and the names this plan creates or renames to.
  const planNames = [];
  const used = [...snapEx, ...[...seedById].filter(([id]) => !snapById.has(id)).map(([id, e]) => ({ id, name: e.name }))];
  const taken = (name, selfId) => [...used, ...planNames].some((e) => e.id !== selfId && sameName(e.name, name));
  const createRows = [], mapping = [];
  const updates = new Map(); // exercise id -> ONE full row carrying every change of this plan (rename and/or how-to)
  const touch = (target, patch) => { updates.set(target.id, Object.assign(updates.get(target.id) ?? { ...target.row }, patch)); };
  let exercisesCreated = 0;
  for (const ex of json.exercises) {
    const refId = await seedId(userId, ex.ref);
    let m = mapExercise(ex, library, { ownId: refId });
    if (m.kind === 'create' && planNames.some((e) => e.id !== refId && sameName(e.name, m.name))) m = { ...m, name: `${m.name} (${cap(m.equipment)})`.slice(0, 60) };
    const key = lc(m.name);
    let target = idByName.get(key);
    if (!target) {
      // A row is found by the deterministic id this import would give it OR by name, so a lift he renamed (or whose
      // muscle/equipment he edited, or that this import renamed to the Strive name) is still "existing" and is never re-emitted.
      const seed = seedByName.get(key);
      const cid = seed && m.kind !== 'create' ? await seedId(userId, seed.key) : refId;
      target = idById.get(cid);
      const existing = target ? null : (snapById.get(cid) ?? snapByName.get(key));
      if (existing) target = { id: existing.id, row: { id: existing.id, name: existing.name, muscle_group: existing.muscle_group, equipment: existing.equipment, how_to: existing.how_to ?? '', is_custom: existing.is_custom ?? false, archived: existing.archived ?? false }, how_to: existing.how_to ?? '', noted: false };
      else if (!target && seed && m.kind !== 'create') {
        target = { id: cid, row: seedRow(seed, cid), how_to: seed.how_to, noted: false };
        createRows.push(target.row);
      } else if (!target) {
        target = { id: cid, row: { id: cid, name: m.name, muscle_group: m.muscle_group, equipment: m.equipment, how_to: '', is_custom: false, archived: false }, how_to: '', noted: false };
        createRows.push(target.row);
        planNames.push({ id: cid, name: m.name });
        exercisesCreated++;
      }
      idByName.set(key, target);
      idById.set(target.id, target);
    }
    exerciseMap.set(ex.ref, { id: target.id, name: m.name, kind: m.kind });
    const seed = seedById.get(target.id);
    // A library lift takes the exact Strive name, but only while it still has its untouched seed name (a name he chose stays)
    // and only when no other exercise holds that name. Two Strive names on one lift: the first in the export's exercise order
    // names it, the later ones are plain aliases (no second rename).
    let renamed = null;
    if (m.kind !== 'create' && !target.named) {
      target.named = true;
      const want = String(ex.name_en).trim().slice(0, 60);
      if (seed && target.row.name === seed.name && want && want !== target.row.name && !taken(want, target.id)) {
        touch(target, { name: want });
        planNames.push({ id: target.id, name: want });
        renamed = want;
      }
    }
    mapping.push({ strive: ex.name_en, lifeos: target.row.name, kind: m.kind, renamed });
    const seedText = (seed ?? seedByName.get(key))?.how_to;
    // Only an empty how-to or the untouched seed text is replaced; anything else is his own edit and stays.
    if (ex.how_to && !target.noted && (target.how_to === '' || target.how_to === seedText) && ex.how_to !== target.how_to) {
      touch(target, { how_to: ex.how_to });
      target.noted = true;
    }
  }
  const howRows = [...updates.values()];
  const exerciseOf = (ref) => {
    const e = exerciseMap.get(ref);
    if (!e) throw new ImportError('format', `unknown exercise ${ref}`);
    return e.id;
  };

  // routines and items
  const snapRoutines = snapshot.routines ?? [];
  const routineById = new Map(snapRoutines.map((r) => [r.id, r]));
  const routineByName = new Map(snapRoutines.map((r) => [lc(r.name), r]));
  const routineRows = [], itemRows = [];
  const routineIdByRef = new Map();
  const resolved = [];
  let anyOurs = false;
  // Routines and items are written on the first import only (no imported workout exists yet). The outbox runs ops FIFO but a
  // permanently rejected op (non-network error) is moved to `failed` and the flush CONTINUES, so routines can be rejected while the
  // workouts land; a repeat then skips them for good. The in-app import therefore reports that case explicitly (import-view.js).
  const firstImport = importState.importedRefs.size === 0;
  for (const [i, r] of json.routines.entries()) {
    const id = await seedId(userId, r.ref);
    const byId = routineById.get(id);
    const byName = routineByName.get(lc(r.name));
    let fillItems = false;
    if (byId) { routineIdByRef.set(r.ref, id); fillItems = firstImport && !(snapshot.routineItems ?? []).some((x) => x.routine_id === id); anyOurs = true; }
    else if (byName) routineIdByRef.set(r.ref, byName.id);
    else if (!firstImport) routineIdByRef.set(r.ref, null);
    else { routineRows.push({ id, name: r.name.slice(0, 40), sort: i, archived: false }); routineIdByRef.set(r.ref, id); fillItems = true; anyOurs = true; }
    resolved.push({ id: routineIdByRef.get(r.ref), name: r.name });
    if (fillItems) {
      for (const it of r.items) {
        itemRows.push({ id: await seedId(userId, it.ref), routine_id: id, exercise_id: exerciseOf(it.exercise_ref), position: it.position, target_sets: it.sets, target_reps_min: it.reps_min, target_reps_max: it.reps_max });
      }
    }
  }

  // schedule and the gym habit target: first import only (importedRefs empty), never over an existing schedule
  const scheduleOps = [];
  const slotsExist = (snapshot.scheduleSlots ?? []).length > 0;
  if (firstImport && anyOurs && resolved.length) {
    let slots = snapshot.scheduleSlots ?? [];
    if (!slotsExist) {
      const u = resolved.find((r) => /upper/i.test(r.name));
      const l = resolved.find((r) => /lower/i.test(r.name));
      const rest = resolved.filter((r) => r !== u && r !== l);
      const up = u ?? rest.shift();
      const lo = l ?? rest.shift();
      slots = defaultSlots(up?.id ?? null, lo?.id ?? null);
      const rows = [];
      for (const s of slots) rows.push({ id: await seedId(userId, `schedule:${s.weekday}`), weekday: s.weekday, routine_id: s.routine_id });
      scheduleOps.push({ ...upsertRows('schedule_slots', rows), onConflict: 'user_id,weekday' });
    }
    const habits = snapshot.habits ?? [];
    const gymId = snapshot.settings?.gym_habit_id;
    const habit = habits.find((h) => h.id === gymId) ?? habits.find((h) => lc(h.name) === 'gym');
    const patch = habit ? gymTargetPatch(habit, slots) : null;
    if (patch) scheduleOps.push(upsertRows('habits', [patch]));
  }

  // PR flags: replay over ALL sessions of each mapped exercise, so a re-run's new sessions are judged against history
  const sessionsByExercise = new Map();
  for (const w of json.workouts) {
    for (const e of w.exercises) {
      const id = exerciseOf(e.exercise_ref);
      if (!sessionsByExercise.has(id)) sessionsByExercise.set(id, new Map());
      const per = sessionsByExercise.get(id);
      if (!per.has(w.ref)) per.set(w.ref, { startedAt: w.started_at, sets: [] });
      per.get(w.ref).sets.push(...e.sets.map((s) => ({ id: s.ref, set_no: s.set_no, reps: s.reps, weight_kg: s.weight_kg, type: s.type, done_at: s.done_at })));
    }
  }
  const prs = new Map();
  for (const per of sessionsByExercise.values()) for (const [ref, flag] of replayPrs([...per.values()])) prs.set(ref, flag);

  // workouts and children
  const { importedRefs, nativeDays, childCounts } = importState;
  const workoutRows = [], entryRows = [], setRows = [];
  const possibleDuplicates = [];
  let alreadyImported = 0, newSessions = 0, repaired = 0;
  for (const w of json.workouts) {
    const day = workoutDay(w.started_at);
    const wid = await seedId(userId, w.ref);
    let children = true;
    if (importedRefs.has(w.ref)) {
      alreadyImported++;
      // Count-based repair (A1): a deliberate re-import also brings back an imported entry/set he deleted from a workout whose
      // counts now fall short. Accepted: a re-import is an explicit action, and counts cannot tell a cut-off write from a deletion.
      const have = childCounts?.get(w.ref) ?? { entries: 0, sets: 0 };
      const need = { entries: w.exercises.length, sets: w.exercises.reduce((n, e) => n + e.sets.length, 0) };
      children = !!childCounts && (have.entries < need.entries || have.sets < need.sets);
      if (children) repaired++;
    } else if (nativeDays.has(day) && !includeDuplicates.has(w.ref)) {
      possibleDuplicates.push({ ref: w.ref, day, name: w.name });
      continue;
    } else {
      newSessions++;
      workoutRows.push({
        id: wid, routine_id: routineIdByRef.get(w.routine_ref) ?? null, name: String(w.name).slice(0, 40) || 'Workout', day,
        started_at: w.started_at, ended_at: w.ended_at, duration_known: w.duration_known, note: w.note ?? '', imported: true, source_ref: w.ref,
      });
    }
    if (!children) continue;
    for (const e of w.exercises) {
      const weid = await seedId(userId, e.ref);
      entryRows.push({ id: weid, workout_id: wid, exercise_id: exerciseOf(e.exercise_ref), position: e.position });
      for (const s of e.sets) {
        setRows.push({ id: await seedId(userId, s.ref), workout_exercise_id: weid, set_no: s.set_no, reps: s.reps, weight_kg: s.weight_kg, type: s.type, is_pr: prs.get(s.ref) === true, done_at: s.done_at });
      }
    }
  }

  const ig = { ignoreDuplicates: true };
  const ops = [
    ...batchUpserts('exercises', createRows, ig),
    ...batchUpserts('exercises', howRows),
    ...batchUpserts('routines', routineRows, ig),
    ...batchUpserts('routine_items', itemRows, ig),
    ...scheduleOps,
    ...batchUpserts('workouts', workoutRows, ig),
    ...batchUpserts('workout_exercises', entryRows, ig),
    ...batchUpserts('sets', setRows, ig),
  ];
  const preview = {
    sessions: json.counts.sessions, entries: json.counts.entries, sets: json.counts.sets, routines: json.routines.length,
    exercisesCreated, howToNotes: json.exercises.filter((x) => x.how_to).length, sessionNotes: json.workouts.filter((w) => w.note).length,
    alreadyImported, possibleDuplicates, newSessions, repaired, mapping,
  };
  return { preview, ops, exerciseMap };
}
