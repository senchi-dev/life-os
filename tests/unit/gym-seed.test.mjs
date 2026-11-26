import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GYM_EXERCISES, MUSCLE_GROUPS, EQUIPMENT } from '../../js/data/gym-seed.js';
import { slug } from '../../js/lib/ids.js';

test('seed has 72 exercises with the spec per-muscle counts', () => {
  assert.equal(GYM_EXERCISES.length, 72);
  const want = { chest: 10, back: 13, shoulders: 8, biceps: 7, triceps: 6, quads: 8, hamstrings: 5, glutes: 4, calves: 3, core: 6, forearms: 2 };
  assert.deepEqual(MUSCLE_GROUPS, Object.keys(want));
  for (const [g, n] of Object.entries(want)) assert.equal(GYM_EXERCISES.filter((e) => e.muscle_group === g).length, n, g);
});

test('names and keys are unique, keys are slugs, fields are valid', () => {
  const names = new Set(GYM_EXERCISES.map((e) => e.name.toLowerCase()));
  const keys = new Set(GYM_EXERCISES.map((e) => e.key));
  assert.equal(names.size, 72);
  assert.equal(keys.size, 72);
  for (const e of GYM_EXERCISES) {
    assert.equal(e.key, slug(e.name));
    assert.ok(EQUIPMENT.includes(e.equipment), e.name);
    assert.ok(MUSCLE_GROUPS.includes(e.muscle_group), e.name);
    assert.ok(e.how_to.length > 0 && e.how_to.length <= 2000, e.name);
    assert.ok(e.name.length >= 1 && e.name.length <= 60, e.name);
  }
});

test('spot checks', () => {
  const by = (n) => GYM_EXERCISES.find((e) => e.name === n);
  assert.equal(by('Ab Wheel Rollout').equipment, 'other');
  assert.equal(by('Bench Press').how_to, 'Shoulder blades pinched, bar to lower chest, feet planted.');
  assert.equal(by('Bench Press').key, 'bench-press');
});
