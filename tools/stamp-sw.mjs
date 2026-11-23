// Node-only helper (not shipped): hashes the service-worker SHELL files, writes `// shell-hash: <hex>` into
// sw.js and bumps CACHE ('lifeos-v1-N' -> N+1) only when the hash changed. Run via `npm run stamp`.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HASH_RE = /^\/\/ shell-hash: ([0-9a-f]{64})$/m;

export function readShellFiles(sw) {
  const body = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== './' && p !== 'sw.js');
}

export function readStoredHash(sw) {
  return sw.match(HASH_RE)?.[1] ?? null;
}

// sha256 over "<path>\0<content>\0" for each file, sorted by path. `read` is injectable for tests.
export function computeShellHash(root, files, read = (p) => readFileSync(join(root, p))) {
  const hash = createHash('sha256');
  for (const p of [...files].sort()) hash.update(p).update('\0').update(read(p)).update('\0');
  return hash.digest('hex');
}

export function stamp(root = ROOT) {
  const swPath = join(root, 'sw.js');
  let sw = readFileSync(swPath, 'utf8');
  const next = computeShellHash(root, readShellFiles(sw));
  const prev = readStoredHash(sw);
  if (prev === next) return { changed: false, hash: next };
  sw = sw.replace(/const CACHE = 'lifeos-v1-(\d+)';/, (_, n) => `const CACHE = 'lifeos-v1-${Number(n) + 1}';`);
  sw = prev
    ? sw.replace(HASH_RE, `// shell-hash: ${next}`)
    : sw.replace(/^(const CACHE = .*)$/m, `$1\n// shell-hash: ${next}`);
  writeFileSync(swPath, sw);
  return { changed: true, hash: next, cache: sw.match(/const CACHE = '([^']+)'/)[1] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = stamp();
  console.log(r.changed ? `stamped ${r.cache} (${r.hash.slice(0, 12)})` : 'shell unchanged');
}
