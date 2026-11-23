import { h } from '../ui/dom.js';

// Task 10 stand-ins; Tasks 12-15 replace each with the real view.
const make = (title) => (root, app) => {
  root.replaceChildren(
    h('h1', {}, title),
    h('p', { class: 'muted' }, 'Placeholder view.'),
  );
};
export const renderToday = make('Today');
export const renderCalendar = make('Calendar');
export const renderReview = make('Review');
export const renderMore = make('More');
