// Pure validation for the calendar event form. Returns one message, or null when valid.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export function validateEvent(e) {
  const title = String(e?.title ?? '').trim();
  if (!title) return 'Title required';
  if (title.length > 80) return 'Title: 80 characters max';
  if (!DATE.test(String(e?.date ?? ''))) return 'Date required';
  const start = e?.start_time || '';
  const end = e?.end_time || '';
  if (start && !TIME.test(start)) return 'Start time is not valid';
  if (end && !TIME.test(end)) return 'End time is not valid';
  if (end && !start) return 'Add a start time first';
  if (start && end && end <= start) return 'End must be after start';
  return null;
}
