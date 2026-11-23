import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeShellHash, readStoredHash, readShellFiles } from '../../tools/stamp-sw.mjs';

const root = new URL('../../', import.meta.url).pathname;

test('sw.js shell-hash matches the shipped files (run `npm run stamp` if this fails)', () => {
  const sw = readFileSync(root + 'sw.js', 'utf8');
  const stored = readStoredHash(sw);
  const actual = computeShellHash(root, readShellFiles(sw));
  assert.equal(stored, actual, 'Shell files changed but sw.js was not re-stamped: run `npm run stamp` (it bumps CACHE too).');
});

test('shell hash ignores sw.js itself and changes when a shell file changes', () => {
  const sw = readFileSync(root + 'sw.js', 'utf8');
  const files = readShellFiles(sw);
  assert.ok(!files.includes('sw.js'));
  const a = computeShellHash(root, files, () => 'x');
  const b = computeShellHash(root, files, (p) => (p === 'js/app.js' ? 'y' : 'x'));
  assert.notEqual(a, b);
});
