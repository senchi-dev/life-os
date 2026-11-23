import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../js/config.js';

const root = new URL('../../', import.meta.url);
const versions = readFileSync(new URL('vendor/VERSIONS.md', root), 'utf8');
const row = versions.split('\n').find((l) => l.includes('@supabase/supabase-js'));
const cells = row.split('|').map((s) => s.trim());
const placeholder = SUPABASE_URL.includes('REPLACE_') || SUPABASE_ANON_KEY.includes('REPLACE_');
const skip = placeholder ? 'config.js still holds placeholders' : false;

test('vendor/supabase.js matches the recorded sha256', () => {
  const sha = createHash('sha256').update(readFileSync(new URL('vendor/supabase.js', root))).digest('hex');
  assert.equal(sha, cells[4]);
});

test('recorded version is 2.x and the bundle defines createClient', () => {
  assert.match(cells[2], /^2\.\d+\.\d+$/);
  assert.ok(cells[3].includes(`@${cells[2]}/`));
  const src = readFileSync(new URL('vendor/supabase.js', root), 'utf8');
  assert.match(src, /^var supabase=/);
  assert.ok(src.includes('createClient'));
});

test('config URL has the project format', { skip }, () => {
  assert.match(SUPABASE_URL, /^https:\/\/[a-z0-9]{20}\.supabase\.co$/);
});

test('config key is non-empty, public, and not a service_role key', { skip }, () => {
  assert.ok(SUPABASE_ANON_KEY.length > 0);
  assert.ok(!SUPABASE_ANON_KEY.includes('service_role'));
  if (SUPABASE_ANON_KEY.startsWith('sb_publishable_')) return;
  const parts = SUPABASE_ANON_KEY.split('.');
  assert.equal(parts.length, 3, 'expected a JWT or an sb_publishable_ key');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.notEqual(payload.role, 'service_role');
});
