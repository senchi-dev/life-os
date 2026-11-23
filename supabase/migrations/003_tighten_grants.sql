-- 003: tighten grants. Idempotent; safe to re-run. Run after 001 and 002.
-- Supabase default privileges may give `authenticated` every privilege (incl. TRUNCATE, REFERENCES, TRIGGER)
-- on new public tables. Reset to exactly the four verbs RLS governs. `anon` keeps nothing (001 revoked it).

revoke all on public.settings from authenticated;
grant select, insert, update, delete on public.settings to authenticated;

revoke all on public.habits from authenticated;
grant select, insert, update, delete on public.habits to authenticated;

revoke all on public.habit_logs from authenticated;
grant select, insert, update, delete on public.habit_logs to authenticated;

revoke all on public.rituals from authenticated;
grant select, insert, update, delete on public.rituals to authenticated;

revoke all on public.ritual_logs from authenticated;
grant select, insert, update, delete on public.ritual_logs to authenticated;

revoke all on public.events from authenticated;
grant select, insert, update, delete on public.events to authenticated;

revoke all on public.sleep from authenticated;
grant select, insert, update, delete on public.sleep to authenticated;

revoke all on public.water from authenticated;
grant select, insert, update, delete on public.water to authenticated;

revoke all on public.books from authenticated;
grant select, insert, update, delete on public.books to authenticated;

revoke all on public.daily from authenticated;
grant select, insert, update, delete on public.daily to authenticated;

revoke all on public.reviews from authenticated;
grant select, insert, update, delete on public.reviews to authenticated;
