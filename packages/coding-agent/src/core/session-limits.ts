/** Read buffer for journal and catalog scans. */
export const SESSION_READ_BUFFER_BYTES = 64 * 1024;
/** Upper bound for one journal record; larger records are corrupt by contract. */
export const MAX_SESSION_RECORD_BYTES = 64 * 1024 * 1024;
