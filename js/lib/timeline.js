// Day/week timeline geometry: grid bounds and side-by-side columns for overlapping timed items. Pure; minutes from local midnight.
export const GRID_START = 360;
export const GRID_END = 1440;
const MIN_LEN = 15;

const timed = (i) => !i.allDay && i.start != null;

// 06:00, or earlier to the whole hour when any shown timed item starts before it.
export function gridStart(dayLists) {
  let earliest = GRID_START;
  for (const list of dayLists) for (const i of list) if (timed(i) && i.start < earliest) earliest = i.start;
  return Math.min(GRID_START, Math.floor(earliest / 60) * 60);
}

export function layoutDay(items) {
  const rows = items.filter(timed).map((item) => {
    const start = item.start;
    const end = Math.min(GRID_END, Math.max(item.end ?? start, start + MIN_LEN));
    return { item, start, end, col: 0, cols: 1 };
  }).sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  let cluster = [];
  let colEnds = [];
  let clusterEnd = -Infinity;
  const close = () => { for (const r of cluster) r.cols = colEnds.length; };
  for (const r of rows) {
    if (r.start >= clusterEnd) { close(); cluster = []; colEnds = []; clusterEnd = -Infinity; }
    let col = colEnds.findIndex((e) => e <= r.start);
    if (col < 0) { col = colEnds.length; colEnds.push(r.end); } else colEnds[col] = r.end;
    r.col = col;
    cluster.push(r);
    clusterEnd = Math.max(clusterEnd, r.end);
  }
  close();
  return rows;
}
