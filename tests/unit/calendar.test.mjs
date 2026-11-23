import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../../js/lib/event-form.js';

const ok = { title: 'Dentist', date: '2026-11-24', start_time: '14:00', end_time: '15:00' };

test('valid event passes', () => {
  assert.equal(validateEvent(ok), null);
  assert.equal(validateEvent({ title: 'Dinner', date: '2026-11-24' }), null);
  assert.equal(validateEvent({ ...ok, start_time: '', end_time: '' }), null);
  assert.equal(validateEvent({ ...ok, end_time: null }), null);
});

test('title is required, trimmed, at most 80 chars', () => {
  assert.equal(validateEvent({ ...ok, title: '' }), 'Title required');
  assert.equal(validateEvent({ ...ok, title: '   ' }), 'Title required');
  assert.equal(validateEvent({ ...ok, title: undefined }), 'Title required');
  assert.equal(validateEvent({ ...ok, title: 'x'.repeat(80) }), null);
  assert.equal(validateEvent({ ...ok, title: 'x'.repeat(81) }), 'Title: 80 characters max');
});

test('date is required and well formed', () => {
  assert.equal(validateEvent({ ...ok, date: '' }), 'Date required');
  assert.equal(validateEvent({ ...ok, date: null }), 'Date required');
  assert.equal(validateEvent({ ...ok, date: '24/11/2026' }), 'Date required');
});

test('end must be after start', () => {
  assert.equal(validateEvent({ ...ok, start_time: '10:00', end_time: '09:00' }), 'End must be after start');
  assert.equal(validateEvent({ ...ok, start_time: '10:00', end_time: '10:00' }), 'End must be after start');
});

test('end without start is rejected', () => {
  assert.equal(validateEvent({ ...ok, start_time: '', end_time: '09:00' }), 'Add a start time first');
  assert.equal(validateEvent({ ...ok, start_time: null, end_time: '09:00' }), 'Add a start time first');
});

import { splitWindow } from '../../js/lib/event-form.js';

test('splitWindow: day 6 inside, day 7 later, yesterday excluded, sorted', () => {
  const ev = (id, date, start_time = null) => ({ id, title: id, date, start_time });
  const today = '2026-11-23';
  const events = [
    ev('later2', '2026-12-31', '09:00'), ev('past', '2026-11-22'), ev('d7', '2026-11-30'),
    ev('d6b', '2026-11-29', '18:00'), ev('d6a', '2026-11-29', '08:00'), ev('later1', '2026-12-01'),
    ev('later1b', '2026-12-01', '07:00'),
  ];
  const { inWindow, later } = splitWindow(events, today, 7);
  assert.deepEqual(inWindow.map((e) => e.id), ['d6a', 'd6b']);
  assert.deepEqual(later.map((e) => e.id), ['d7', 'later1', 'later1b', 'later2']);
});
