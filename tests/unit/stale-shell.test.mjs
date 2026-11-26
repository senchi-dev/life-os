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

import { checkStamp } from '../../tools/stamp-sw.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const disk = (p) => readFileSync(join(root, p));

test('checkStamp is true on the committed tree', () => {
  assert.equal(checkStamp(root), true);
});

test('checkStamp is false when a SHELL file differs (injected reader, no disk writes)', () => {
  const files = readShellFiles(readFileSync(root + 'sw.js', 'utf8'));
  const victim = files[0];
  const read = (p) => (p === victim ? Buffer.concat([disk(p), Buffer.from('\n// tampered')]) : disk(p));
  assert.equal(checkStamp(root, read), false);
});

test('checkStamp is false when the hash line is altered or missing', () => {
  const sw = readFileSync(root + 'sw.js', 'utf8');
  const bad = sw.replace(/shell-hash: [0-9a-f]/, (m) => m.slice(0, -1) + (m.endsWith('0') ? '1' : '0'));
  assert.notEqual(bad, sw);
  const swRead = (text) => (p) => (p === 'sw.js' ? Buffer.from(text) : disk(p));
  assert.equal(checkStamp(root, swRead(bad)), false);
  assert.equal(checkStamp(root, swRead(sw.replace(/^\/\/ shell-hash:.*\n/m, ''))), false);
});

test('checkStamp ignores a CACHE-only edit (stamp() would not change sw.js either)', () => {
  const sw = readFileSync(root + 'sw.js', 'utf8');
  const edited = sw.replace(/lifeos-v1-(\d+)/, 'lifeos-v1-999999');
  assert.equal(checkStamp(root, (p) => (p === 'sw.js' ? Buffer.from(edited) : disk(p))), true);
});

test('stamp-sw.mjs --check exits 0 on the committed tree and writes nothing', () => {
  const before = readFileSync(root + 'sw.js', 'utf8');
  const r = spawnSync('node', ['tools/stamp-sw.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(root + 'sw.js', 'utf8'), before);
});

test('checkStamp is false (no throw) when a SHELL file is missing', () => {
  const read = (p) => { if (p === 'js/app.js') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return disk(p); };
  assert.equal(checkStamp(root, read), false);
});

test('--check prints the stale message, not a stack trace, for a missing shell file; works via a symlink', async () => {
  const { mkdtempSync, cpSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'stamp-'));
  cpSync(root + 'tools', join(d, 'tools'), { recursive: true });
  cpSync(root + 'sw.js', join(d, 'sw.js'));
  const r = spawnSync('node', ['tools/stamp-sw.mjs', '--check'], { cwd: d, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stamp is stale: run npm run stamp/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
  const link = join(d, 'link.mjs');
  symlinkSync(join(root, 'tools/stamp-sw.mjs'), link);
  const ok = spawnSync('node', [link, '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /stamp is current/);
  rmSync(d, { recursive: true, force: true });
});
