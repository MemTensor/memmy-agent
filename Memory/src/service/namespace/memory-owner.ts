/**
 * Account-independent owner for newly created local memory state.
 * Kept as a string for the existing NOT NULL storage/wire contracts. This is
 * not an account UID. Historical owners remain unchanged; no data migration.
 * Account credentials and model billing attribution are resolved separately.
 */
export const DEVICE_MEMORY_OWNER = "__memmy_device_memory__";
