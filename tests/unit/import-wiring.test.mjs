// Wiring of the Strive import screen: shipped in the service-worker shell, mounted by More, reset on sign-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('sw.js ships the import view and its model', () => {
  const sw = read('sw.js');
  assert.match(sw, /'js\/ui\/import-view\.js'/);
  assert.match(sw, /'js\/ui\/import-model\.js'/);
});

test('More mounts the import body and resets its state with the rest of More', () => {
  const src = read('js/ui/more-view.js');
  assert.match(src, /import \{ importBody, resetImport \} from '\.\/import-view\.js'/);
  assert.match(src, /striveBody = \(app\) => importBody\(app\)/);
  assert.match(src, /export function resetMore\(\) \{\n  resetImport\(\);/);
});

test('the file input accepts only JSON, has a visible label, and text goes through h() only', () => {
  const src = read('js/ui/import-view.js');
  assert.match(src, /accept: '\.json,application\/json'/);
  assert.match(src, /Strive export file \(\.json\)/);
  assert.ok(!/inner\s*html|outer\s*html|insertAdjacent|document\.write/i.test(src));
  assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon/.test(src), 'the file is never uploaded by this module');
});

test('doImport guards against a reset during the import (token taken before the await, checked after it)', () => {
  const src = read('js/ui/import-view.js');
  const body = src.slice(src.indexOf('async function doImport'));
  const at = (re) => body.search(re);
  assert.ok(at(/const token = latest\.next\(\)/) > 0);
  assert.ok(at(/const token = latest\.next\(\)/) < at(/await f\.commit\(\)/));
  assert.ok(at(/await f\.commit\(\)/) < at(/latest\.isCurrent\(token\)/));
  assert.ok(at(/withPlanning\(st\)/) > 0, 'planning is on while the post-partial plan is computed');
});

test('the in-app mapping table shows the same line as the dry-run (mappingLine)', () => {
  const src = read('js/ui/import-view.js');
  assert.match(src, /import \{[^}]*\bmappingLine\b[^}]*\} from '\.\.\/lib\/strive-import\.js'/);
  assert.match(src, /h\('li', \{\}, mappingLine\(m\)\)/);
  assert.match(read('tools/import-strive.mjs'), /mappingLine\(/);
});
