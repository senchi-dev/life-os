// FK-safe insert order for the v1 tables.
// Read windows shared by loadSnapshot and the Review view (one source of truth).
export const SNAPSHOT_PAST_DAYS = 42;          // default look-back for day-keyed tables
export const HABIT_LOG_PAST_DAYS = 70;         // habit_logs look-back: the 28-day consistency of the oldest reviewable week
export const CONSISTENCY_LOOKBACK_DAYS = 21;   // consistency28 reaches back to weekStart - 21 (week end - 27)
export const V1_TABLES = ['settings','habits','habit_logs','rituals','ritual_logs','events','sleep','water','books','daily','reviews'];
// Phase 2a gym tables, FK-safe order: parents before children.
export const GYM_TABLES = ['exercises','routines','routine_items','schedule_slots','workouts','workout_exercises','sets'];
export const ALL_TABLES = [...V1_TABLES, ...GYM_TABLES];
export const GYM_SNAPSHOT_DAYS = 42;           // workout headers look-back in the snapshot
export const GYM_PAGE = 1000;                  // page size for gym index builds and exports
export const IMPORT_BATCH = 200;               // rows per outbox batch in the Strive import
