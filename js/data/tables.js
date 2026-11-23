// FK-safe insert order for the v1 tables.
// Read windows shared by loadSnapshot and the Review view (one source of truth).
export const SNAPSHOT_PAST_DAYS = 42;          // default look-back for day-keyed tables
export const HABIT_LOG_PAST_DAYS = 70;         // habit_logs look-back: the 28-day consistency of the oldest reviewable week
export const CONSISTENCY_LOOKBACK_DAYS = 21;   // consistency28 reaches back to weekStart - 21 (week end - 27)
export const V1_TABLES = ['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','books','daily','reviews'];
