// Pure helpers of the Strive import UI: preview line, error and result messages, view state, stale-result guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportError } from '../../js/lib/strive-import.js';
import {
  previewLine, importErrorMessage, resultMessage, GENERIC_ERROR, NOT_STRIVE, INCOMPLETE, NOT_READY, TOO_BIG, MAX_FILE_BYTES,
  initialState, withFile, withPreview, withError, toggleDuplicate, setMapOpen, startImport, finishImport, canImport, importLabel, duplicateRows, createLatest, withPlanning, repairNote,
} from '../../js/ui/import-model.js';

const P = { sessions: 28, entries: 249, sets: 628, routines: 2, exercisesCreated: 5, howToNotes: 11, sessionNotes: 1, alreadyImported: 0, possibleDuplicates: [], newSessions: 28, repaired: 0, mapping: [] };

test('preview line exactly as the brief sample', () => {
  assert.equal(previewLine({ ...P, alreadyImported: 3, possibleDuplicates: [{}, {}] }),
    '28 sessions · 249 exercise entries · 628 sets · 2 routines · 5 exercises created · 11 how-to notes · 1 session note · 3 already imported · 2 possible duplicates');
});

test('singular at 1, plural at 0 and 2 for every noun', () => {
  const one = previewLine({ ...P, sessions: 1, entries: 1, sets: 1, routines: 1, exercisesCreated: 1, howToNotes: 1, sessionNotes: 1, alreadyImported: 1, possibleDuplicates: [{}] });
  assert.equal(one, '1 session · 1 exercise entry · 1 set · 1 routine · 1 exercise created · 1 how-to note · 1 session note · 1 already imported · 1 possible duplicate');
  const zero = previewLine({ ...P, sessions: 0, entries: 0, sets: 0, routines: 0, exercisesCreated: 0, howToNotes: 0, sessionNotes: 0, alreadyImported: 0, possibleDuplicates: [] });
  assert.equal(zero, '0 sessions · 0 exercise entries · 0 sets · 0 routines · 0 exercises created · 0 how-to notes · 0 session notes · 0 already imported · 0 possible duplicates');
  const two = previewLine({ ...P, sessions: 2, entries: 2, sets: 2, routines: 2, exercisesCreated: 2, howToNotes: 2, sessionNotes: 2, alreadyImported: 2, possibleDuplicates: [{}, {}] });
  assert.match(two, /^2 sessions · 2 exercise entries · 2 sets · 2 routines · 2 exercises created · 2 how-to notes · 2 session notes · 2 already imported · 2 possible duplicates$/);
});

test('error messages: exact texts and every ImportError code', () => {
  assert.equal(NOT_STRIVE, 'This is not a Strive export from tools/import-strive.mjs.');
  assert.equal(INCOMPLETE, 'The file is incomplete (counts do not match).');
  assert.equal(NOT_READY, 'Exercise library not ready yet. Try again in a minute.');
  assert.equal(GENERIC_ERROR, 'Import failed. Nothing was changed.');
  assert.equal(importErrorMessage(new ImportError('counts', 'x')), INCOMPLETE);
  assert.equal(importErrorMessage(new ImportError('format', 'not a Life OS Strive export')), NOT_STRIVE);
  const secret = 'SECRET-NOTE-BODY';
  const how = importErrorMessage(new ImportError('format', `how-to note too long (2001 > 2000): Face Pull`));
  assert.match(how, /Face Pull/); assert.match(how, /2000/);
  const sess = importErrorMessage(new ImportError('format', `session note too long (2500 > 2000): Upper Force`));
  assert.match(sess, /Upper Force/);
  for (const m of [how, sess]) assert.ok(!m.includes(secret));
  assert.match(importErrorMessage(new ImportError('format', 'unknown exercise strive:exercises:e1')), /exercise/i);
  assert.ok(!importErrorMessage(new ImportError('format', 'unknown exercise strive:exercises:e1')).includes('strive:'));
  assert.match(importErrorMessage(new ImportError('unit', 'only metric (kg) sets can be imported')), /kilogram/i);
  assert.match(importErrorMessage(new ImportError('set-type', 'unsupported set type: failure')), /set type/i);
  assert.ok(!importErrorMessage(new ImportError('set-type', 'unsupported set type: failure')).includes('failure'));
  assert.match(importErrorMessage(new ImportError('timestamp', 'bad')), /2020/);
  assert.equal(importErrorMessage(new ImportError('weird', 'x')), GENERIC_ERROR);
  assert.equal(importErrorMessage(new TypeError('boom')), GENERIC_ERROR);
  assert.equal(importErrorMessage(null), GENERIC_ERROR);
  assert.equal(importErrorMessage(Object.assign(new Error('x'), { kind: 'network' })), 'You seem to be offline. Connect and try again; nothing was changed.');
  assert.equal(importErrorMessage(Object.assign(new Error('x'), { kind: 'auth' })), 'Your session expired. Sign in again; nothing was changed.');
});

test('a long item name in an error is trimmed and whitespace collapsed', () => {
  const name = `${'A'.repeat(100)}\n  B`;
  const m = importErrorMessage(new ImportError('format', `how-to note too long (2001 > 2000): ${name}`));
  assert.ok(m.length < 200);
  assert.ok(!m.includes('\n'));
});

test('size limit constant is 20 MB and the message says so', () => {
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.match(TOO_BIG, /20 MB/);
});

test('result messages: done, offline, partial, auth, repaired-only, error', () => {
  assert.equal(resultMessage({ status: 'done' }, { ...P, newSessions: 3 }), 'Imported 3 sessions.');
  assert.equal(resultMessage({ status: 'done' }, { ...P, newSessions: 1 }), 'Imported 1 session.');
  assert.equal(resultMessage({ status: 'done' }, { ...P, newSessions: 0, repaired: 2 }), 'Restored missing items for 2 sessions.');
  assert.equal(resultMessage({ status: 'done' }, { ...P, newSessions: 0, repaired: 1 }), 'Restored missing items for 1 session.');
  assert.equal(resultMessage({ status: 'done' }, { ...P, newSessions: 3, repaired: 2 }), '3 sessions imported, 2 sessions repaired.');
  assert.equal(resultMessage({ status: 'done' }, { ...P, newSessions: 1, repaired: 1 }), '1 session imported, 1 session repaired.');
  assert.equal(resultMessage({ status: 'done' }, { ...P, newSessions: 2, repaired: 1 }), '2 sessions imported, 1 session repaired.');
  assert.equal(resultMessage({ status: 'offline', total: 10 }, P), 'Saved on this device. The import finishes when you are back online.');
  assert.equal(resultMessage({ status: 'partial', applied: 7, total: 10 }, P), 'Imported 7 of 10 sessions; some items failed — try again, the import is safe to repeat.');
  assert.match(resultMessage({ status: 'auth', total: 10 }, P), /Sign in/);
  assert.equal(resultMessage({ status: 'partial', applied: 3, total: 3, routinesNotSaved: true }, P), 'The workouts were imported, but the routines or schedule were not, and repeating the import will not recreate them. You can add routines manually in Gym.');
  assert.equal(resultMessage({ status: 'partial', applied: 2, total: 3, routinesNotSaved: true }, P), 'Imported 2 of 3 sessions, but the routines or schedule were not saved, and repeating the import will not recreate them. You can add routines manually in Gym.');
  assert.equal(resultMessage({ status: 'error', message: 'm' }, P), 'm');
});

test('state: choosing a file, preview, toggles survive (pure, immutable)', () => {
  const s0 = initialState();
  assert.equal(s0.stage, 'idle');
  const s1 = withFile(s0, { name: 'a.json', text: '{}' });
  assert.equal(s1.stage, 'reading'); assert.equal(s1.text, '{}'); assert.notEqual(s0, s1); assert.equal(s0.stage, 'idle');
  const dups = [{ ref: 'r1', day: '2026-06-21', name: 'Upper' }, { ref: 'r2', day: '2026-07-14', name: 'Lower' }];
  const s2 = withPreview(s1, { ...P, possibleDuplicates: dups }, null);
  assert.equal(s2.stage, 'preview');
  assert.deepEqual(duplicateRows(s2).map((d) => [d.ref, d.checked]), [['r1', false], ['r2', false]]);
  const s3 = toggleDuplicate(s2, 'r1');
  assert.deepEqual([...s3.includeDuplicates], ['r1']);
  assert.deepEqual([...s2.includeDuplicates], [], 'the old state is untouched');
  // after including r1 the new plan no longer lists it, but the row stays visible and checked
  const s4 = withPreview(s3, { ...P, possibleDuplicates: [dups[1]], newSessions: 29 }, null);
  assert.deepEqual(duplicateRows(s4).map((d) => [d.ref, d.checked]), [['r1', true], ['r2', false]]);
  assert.deepEqual([...toggleDuplicate(s4, 'r1').includeDuplicates], [], 'toggle off');
  assert.equal(setMapOpen(s4, true).mapOpen, true);
  assert.equal(setMapOpen(s4, true).includeDuplicates, s4.includeDuplicates);
});

test('canImport / label: newSessions 0 is "Already imported" and disabled; a repair-only plan is importable', () => {
  assert.deepEqual([canImport({ ...P, newSessions: 0 }), importLabel({ ...P, newSessions: 0 })], [false, 'Already imported']);
  assert.deepEqual([canImport({ ...P, newSessions: 1 }), importLabel({ ...P, newSessions: 1 })], [true, 'Import']);
  assert.deepEqual([canImport({ ...P, newSessions: 0, repaired: 1 }), importLabel({ ...P, newSessions: 0, repaired: 1 })], [true, 'Restore missing items (1 session)']);
  assert.equal(importLabel({ ...P, newSessions: 0, repaired: 3 }), 'Restore missing items (3 sessions)');
  assert.equal(importLabel({ ...P, newSessions: 2, repaired: 3 }), 'Import');
  assert.equal(repairNote({ ...P, newSessions: 2, repaired: 1 }), 'Also restores missing items in 1 session.');
  assert.equal(repairNote({ ...P, newSessions: 2, repaired: 2 }), 'Also restores missing items in 2 sessions.');
  assert.equal(repairNote({ ...P, newSessions: 0, repaired: 2 }), null);
  assert.equal(repairNote({ ...P, newSessions: 2, repaired: 0 }), null);
  assert.equal(canImport(null), false);
});

test('startImport blocks a second start; finish/error release', () => {
  const s = withPreview(withFile(initialState(), { name: 'a', text: 't' }), P, null);
  const a = startImport(s);
  assert.equal(a.stage, 'importing');
  assert.equal(startImport(a), a, 'already importing: same state, no second start');
  assert.equal(startImport(initialState()).stage, 'idle', 'nothing to import');
  const d = finishImport(a, 'Imported 28 sessions.', 'ok');
  assert.equal(d.stage, 'done'); assert.equal(d.text, null, 'file text dropped once imported'); assert.equal(d.message, 'Imported 28 sessions.');
  const e = withError(s, 'bad');
  assert.deepEqual([e.stage, e.message, e.kind], ['error', 'bad', 'error']);
});

test('createLatest: only the newest async result is applied', () => {
  const l = createLatest();
  const a = l.next(); const b = l.next();
  assert.equal(l.isCurrent(a), false); assert.equal(l.isCurrent(b), true);
});

test('planning: a stale preview cannot be imported until the new plan arrives', () => {
  const s = withPreview(withFile(initialState(), { name: 'a', text: 't' }), P);
  const p = withPlanning(s);
  assert.equal(p.planning, true);
  assert.equal(startImport(p), p);
  const n = withPreview(p, P);
  assert.equal(n.planning, false);
  assert.equal(startImport(n).stage, 'importing');
  assert.equal(withError(p, 'x').planning, false);
});
