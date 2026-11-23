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
