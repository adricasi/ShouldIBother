import type { Migration } from "../db.js";

import { pairingSessions } from "./0001-pairing-sessions.js";
import { coreSchema } from "./0002-core-schema.js";
import { betLocks } from "./0003-bet-locks.js";
import { cardNotices } from "./0004-card-notices.js";

/**
 * Every migration in order. A new migration is one file plus one line here; numbers are
 * assigned in the task brief so parallel branches do not clash.
 */
export const MIGRATIONS: readonly Migration[] = [
  pairingSessions,
  coreSchema,
  betLocks,
  cardNotices,
];
