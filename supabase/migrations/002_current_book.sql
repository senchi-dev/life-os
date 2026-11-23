-- Explicit "current book" marker. Idempotent. RLS, force RLS and grants on public.settings
-- (owner policy, authenticated only) from 001 already cover the new column.
alter table public.settings add column if not exists current_book_id uuid references public.books(id) on delete set null;
