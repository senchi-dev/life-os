import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, readStriveDb, loadSqlite, readJsonDir, dryRunReport, isInsideRepo } from '../../tools/import-strive.mjs';
import { mkRaw, FR_NOTE } from './fixtures/strive-json.mjs';
import { validateGymRow } from '../../js/lib/gym-validate.js';
import { STRIVE_FORMAT, normaliseStrive, buildImportPlan } from '../../js/lib/strive-import.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLES = ['routine_logs', 'routine_exercise_logs', 'routine_exercise_set_logs', 'routines', 'routine_exercise_sets', 'exercises', 'routine_exercise_notes', 'routine_exercises'];
const q = (c) => `"${c}"`;

function buildDb(dir, { name = 'x-Strive-backup.db', mutate } = {}) {
  const raw = mkRaw();
  if (mutate) mutate(raw);
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  for (const t of TABLES) {
    const cols = Object.keys(raw[t][0]);
    db.exec(`create table ${t} (${cols.map(q).join(', ')})`);
    const ins = db.prepare(`insert into ${t} (${cols.map(q).join(', ')}) values (${cols.map(() => '?').join(', ')})`);
    for (const r of raw[t]) ins.run(...cols.map((c) => r[c] ?? null));
  }
  db.exec('create table personal_records (id)');
  const pr = db.prepare('insert into personal_records (id) values (?)');
  for (let i = 0; i < 61; i++) pr.run(`pr${i}`);
  db.close();
  return path;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'strive-tool-'));

async function run(argv) {
  const out = []; const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  let code;
  try { code = await main(argv); } finally { process.stdout.write = w; }
  return { code, text: out.join('') };
}

test('dry run: exit 0, no file, report has the counts, mapping rows, no note text', async () => {
  const dir = tmp(); const db = buildDb(dir);
  const { code, text } = await run([db, '--dry-run']);
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, 'x-Strive-backup.strive.json')), false);
  for (const s of ['sessions 3', 'counts OK', 'dropsets 1', 'how-to notes 1 · session notes 1', 'durations known 1 · unknown 2', 'Strive PRs 61']) {
    assert.ok(text.includes(s), `missing: ${s}\n${text}`);
  }
  const lines = text.split('\n').map((l) => l.trim());
  for (const l of ['Incline Bench Press (Dumbbell) -> library: Incline Dumbbell Press, renamed to "Incline Bench Press (Dumbbell)"',
    'Face pull -> library: Face Pull, renamed to "Face pull"', 'Leg press (Machine) -> library: Leg Press, renamed to "Leg press (Machine)"',
    'Crunch -> create: Crunch', 'Lateral raise (Machine) -> create: Lateral raise (Machine)']) assert.ok(lines.includes(l), `missing: ${l}\n${text}`);
  assert.ok(!text.includes('Felt strong'));
  assert.ok(!text.includes('Exécution'));
  assert.ok(!text.includes('poulie'));
  assert.ok(!/log-1|rel-1|strive:/.test(text), 'no ids');
});

test('default run writes <db dir>/<base>.strive.json with the format', async () => {
  const dir = tmp(); const db = buildDb(dir);
  const { code } = await run([db]);
  assert.equal(code, 0);
  const file = join(dir, 'x-Strive-backup.strive.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(json.format, 'lifeos-strive-1');
  assert.equal(json.workouts.length, 3);
  assert.equal(json.workouts[0].note, 'Felt strong');
  assert.equal(json.exercises.find((e) => e.name_en === 'Face pull').how_to, FR_NOTE);
});

test('--out inside the repo is refused (2) and nothing is written; outside works', async () => {
  const dir = tmp(); const db = buildDb(dir);
  const inside = join(REPO, 'x.strive.json');
  const r = await run([db, '--out', inside]);
  assert.equal(r.code, 2);
  assert.equal(existsSync(inside), false);
  const nested = join(REPO, 'no-such-dir', 'deep', 'x.strive.json');
  assert.equal((await run([db, '--out', nested])).code, 2);
  assert.equal(existsSync(join(REPO, 'no-such-dir')), false);
  const outside = join(dir, 'custom.json');
  assert.equal((await run([db, '--out', outside])).code, 0);
  assert.ok(existsSync(outside));
});

test('a db inside the repo with the default out is refused', async () => {
  const dir = mkdtempSync(join(REPO, 'tmp-strive-'));
  try {
    const db = buildDb(dir);
    assert.equal((await run([db])).code, 2);
    assert.equal(existsSync(join(dir, 'x-Strive-backup.strive.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isInsideRepo: boundary and shared-prefix sibling', () => {
  assert.equal(isInsideRepo('/a/life-os/x.json', '/a/life-os'), true);
  assert.equal(isInsideRepo('/a/life-os/sub/x.json', '/a/life-os'), true);
  assert.equal(isInsideRepo('/a/life-os', '/a/life-os'), true);
  assert.equal(isInsideRepo('/a/life-os-backup/x.json', '/a/life-os'), false);
  assert.equal(isInsideRepo('/a/life-osx.json', '/a/life-os'), false);
  assert.equal(isInsideRepo('/a/other/../life-os/x.json', '/a/life-os'), true);
  assert.equal(isInsideRepo('/a/x.json', '/a/life-os'), false);
});

test('orphaned set row -> counts mismatch, exit 1, no file', async () => {
  const dir = tmp();
  const db = buildDb(dir, { mutate: (raw) => { raw.routine_exercise_set_logs.push({ ...raw.routine_exercise_set_logs[0], id: 'orphan', routine_exercise_log_id: 'gone' }); } });
  const r = await run([db]);
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(dir, 'x-Strive-backup.strive.json')), false);
  const d = await run([db, '--dry-run']);
  assert.equal(d.code, 1);
  assert.ok(d.text.includes('COUNTS MISMATCH'));
});

test('readStriveDb: raw shape normalises, reads personal_records count, read-only', () => {
  const dir = tmp(); const db = buildDb(dir);
  const raw = readStriveDb(db);
  assert.equal(raw.sourceCounts.personal_records, 61);
  assert.deepEqual([raw.sourceCounts.sessions, raw.sourceCounts.entries, raw.sourceCounts.sets], [3, 8, 18]);
  assert.equal(normaliseStrive(raw).format, STRIVE_FORMAT);
  assert.equal(raw.routine_exercise_set_logs[0].order, 0);
  assert.throws(() => readStriveDb(join(dir, "missing.db")));
});

test('--from-json-dir reads <table>.json files and gives the same result', async () => {
  const dir = tmp(); const db = buildDb(dir);
  const jd = join(dir, 'json'); mkdirSync(jd);
  const raw = mkRaw();
  for (const t of TABLES) writeFileSync(join(jd, `${t}.json`), JSON.stringify(raw[t]));
  writeFileSync(join(jd, 'personal_records.json'), JSON.stringify(Array.from({ length: 61 }, (_, i) => ({ id: i }))));
  const fromDir = readJsonDir(jd);
  assert.equal(fromDir.sourceCounts.personal_records, 61);
  assert.deepEqual(normaliseStrive(fromDir), normaliseStrive(readStriveDb(db)));
  const out = join(dir, 'viajson.json');
  assert.equal((await run([db, '--from-json-dir', jd, '--out', out])).code, 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).workouts.length, 3);
  assert.throws(() => readJsonDir(join(dir, 'nope')));
});

test('dryRunReport: equal vs mismatch', async () => {
  const json = normaliseStrive(mkRaw());
  const ok = await dryRunReport(json, { sessions: 3, entries: 8, sets: 18, personal_records: 61 }, 61);
  assert.ok(ok.includes('counts OK'));
  const bad = await dryRunReport(json, { sessions: 3, entries: 8, sets: 19, personal_records: 61 }, 61);
  assert.ok(bad.includes('COUNTS MISMATCH') && !bad.includes('counts OK'));
});

test('usage errors exit 2', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['a.db', '--bogus'])).code, 2);
  assert.equal((await run(['a.db', '--out'])).code, 2);
});

const writeJsonDir = (dir, raw = mkRaw()) => {
  const jd = join(dir, 'jd'); mkdirSync(jd);
  for (const t of TABLES) writeFileSync(join(jd, `${t}.json`), JSON.stringify(raw[t]));
  return jd;
};

test('--from-json-dir works end to end without touching readStriveDb / node:sqlite', async () => {
  const dir = tmp(); const jd = writeJsonDir(dir);
  const db = join(dir, 'never-opened-Strive-backup.db'); // does not exist: the db is only used to name the output
  const { code, text } = await run([db, '--from-json-dir', jd]);
  assert.equal(code, 0, text);
  assert.equal(JSON.parse(readFileSync(join(dir, 'never-opened-Strive-backup.strive.json'), 'utf8')).format, STRIVE_FORMAT);
});

test('loadSqlite failure message points at --from-json-dir', () => {
  assert.throws(() => loadSqlite(() => { throw new Error('Cannot find module'); }), /--from-json-dir/);
  assert.equal(typeof loadSqlite().DatabaseSync, 'function');
});

test('readJsonDir: an empty file (sqlite3 -json with zero rows) is []', () => {
  const dir = tmp(); const jd = writeJsonDir(dir);
  writeFileSync(join(jd, 'routine_exercise_notes.json'), '');
  writeFileSync(join(jd, 'routines.json'), '  \n');
  const raw = readJsonDir(jd);
  assert.deepEqual(raw.routine_exercise_notes, []);
  assert.deepEqual(raw.routines, []);
});

test('buildImportPlan on the tool output: ops exist and every gym row is valid', async () => {
  const dir = tmp(); const db = buildDb(dir);
  const json = normaliseStrive(readStriveDb(db));
  const plan = await buildImportPlan({ json, snapshot: { exercises: [] }, importState: { importedRefs: new Set(), nativeDays: new Set(), childCounts: new Map() }, userId: 'u1' });
  assert.ok(plan.ops.length > 0);
  for (const op of plan.ops) for (const row of op.rows) assert.equal(validateGymRow(op.table, row), null, `${op.table} ${JSON.stringify(row)}`);
  assert.ok(plan.ops.some((o) => o.table === 'sets'));
});

test('invoked through a symlink the CLI still runs', async () => {
  const { execFileSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const dir = tmp(); const jd = writeJsonDir(dir);
  const link = join(dir, 'link.mjs'); symlinkSync(join(REPO, 'tools', 'import-strive.mjs'), link);
  const out = execFileSync(process.execPath, [link, join(dir, 'b.db'), '--from-json-dir', jd, '--dry-run'], { encoding: 'utf8' });
  assert.ok(out.includes('counts OK'));
});
