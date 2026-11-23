// The current book: the explicit marker (settings.current_book_id) when it points at an unfinished book,
// else the unfinished book started last (ties: newest created_at, then smallest id).
export function pickCurrentBook(books, settings) {
  const open = (books ?? []).filter((b) => !b.finished_on);
  const marked = settings?.current_book_id ? open.find((b) => b.id === settings.current_book_id) : null;
  if (marked) return marked;
  const key = (b) => [b.started_on ?? '', b.created_at ?? ''];
  let best = null;
  for (const b of open) {
    if (!best) { best = b; continue; }
    const [s1, c1] = key(b), [s0, c0] = key(best);
    if (s1 > s0 || (s1 === s0 && (c1 > c0 || (c1 === c0 && b.id < best.id)))) best = b;
  }
  return best;
}
