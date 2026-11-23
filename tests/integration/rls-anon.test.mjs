// Live check: the anon key alone must never read any v1 table. Skipped until config.js holds real values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../js/config.js';
import { V1_TABLES } from '../../js/data/tables.js';

const placeholder = SUPABASE_URL.includes('REPLACE_') || SUPABASE_ANON_KEY.includes('REPLACE_');
const skip = placeholder ? 'config.js still holds placeholders (REPLACE_...): create the Supabase project and fill js/config.js first' : false;

const variants = {
  'apikey header': { apikey: SUPABASE_ANON_KEY },
  'apikey + bearer anon': { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
};

for (const [name, headers] of Object.entries(variants)) {
  for (const t of V1_TABLES) {
    test(`anon cannot read ${t} (${name})`, { skip }, async () => {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*`, { headers });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not json */ }
      const leaked = res.status === 200 && Array.isArray(body) && body.length > 0;
      assert.ok(!leaked, `${t} returned rows to anon`);
      assert.equal(res.status, 401, `${t}: expected 401, got ${res.status}`);
      assert.equal(body?.code, '42501', `${t}: expected code 42501`);
    });
  }
}
