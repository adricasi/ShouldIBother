import type { Migration } from "../db.js";

import { pairingSessions } from "./0001-pairing-sessions.js";

/**
 * Every migration in order. A new migration is one file plus one line here; numbers are
 * assigned in the task brief so parallel branches do not clash.
 */
export const MIGRATIONS: readonly Migration[] = [pairingSessions];
