import { test } from 'node:test';
import assert from 'node:assert/strict';

const { nextMetric } = await import('../../js/ui/today-view.js');

const model = (...items) => ({ nowNext: items });

test('nextMetric: nothing scheduled → no metric', () => {
  assert.equal(nextMetric(model(), '10:00'), null);
});

test('nextMetric: "Now" while the first item runs, "Next" before it starts or after it ends', () => {
  const ev = { start_time: '09:00', end_time: '10:00', title: 'Standup' };
  assert.deepEqual(nextMetric(model(ev), '09:30'), { key: 'next', label: 'Now', value: '09:00 Standup' });
  assert.equal(nextMetric(model(ev), '09:00').label, 'Now');
  assert.equal(nextMetric(model(ev), '08:59').label, 'Next');
  assert.equal(nextMetric(model(ev), '10:00').label, 'Next');
});

test('nextMetric: an item without an end time is current once it has started', () => {
  const ev = { start_time: '18:00', end_time: null, title: 'Gym' };
  assert.equal(nextMetric(model(ev), '18:30').label, 'Now');
  assert.equal(nextMetric(model(ev), '17:30').label, 'Next');
});
