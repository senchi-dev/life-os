// Shared placeholder for views while there is no snapshot: "Loading…", or a calm Retry after a failed load.
import { h } from './dom.js';

export function loadingNodes(app) {
  if (!app.loadFailed) return [h('p', { class: 'muted' }, 'Loading…')];
  return [
    h('p', { class: 'muted' }, 'Could not load data. Retry'),
    h('button', {
      type: 'button', class: 'tap primary',
      onClick: () => { Promise.resolve(app.refresh()).catch(() => {}); },
    }, 'Retry'),
  ];
}
