// Node-only helper (not shipped): hashes the service-worker SHELL files, writes `// shell-hash: <hex>` into
// sw.js and bumps CACHE ('lifeos-v1-N' -> N+1) only when the hash changed. Run via `npm run stamp`.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
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

// True when the stored hash in sw.js matches the SHELL files, i.e. `stamp()` would change nothing. Writes nothing.
// `read(relPath)` is injectable (it also serves 'sw.js') so tests can alter content without touching disk.
export function checkStamp(root = ROOT, read = (p) => readFileSync(join(root, p))) {
  try {
    const sw = String(read('sw.js'));
    const stored = readStoredHash(sw);
    return stored !== null && stored === computeShellHash(root, readShellFiles(sw), read);
  } catch {
    return false; // a missing/unreadable shell file or a malformed sw.js is a stale stamp, never a crash
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--check')) {
    if (!checkStamp()) {
      console.error('stamp is stale: run npm run stamp');
      process.exit(1);
    }
    console.log('stamp is current');
    process.exit(0);
  }
  const r = stamp();
  console.log(r.changed ? `stamped ${r.cache} (${r.hash.slice(0, 12)})` : 'shell unchanged');
}
