import type { Migration } from "../db.js";

import { pairingSessions } from "./0001-pairing-sessions.js";
import { coreSchema } from "./0002-core-schema.js";
import { betLocks } from "./0003-bet-locks.js";
import { cardNotices } from "./0004-card-notices.js";
import { gemmaCards } from "./0005-gemma-cards.js";
import { cardPhotos } from "./0006-card-photos.js";
import { settleProgress } from "./0007-settle-progress.js";
import { cardSunset } from "./0008-card-sunset.js";
import { laundryPlan } from "./0010-laundry-plan.js";
import { rescue } from "./0011-rescue.js";
import { householdProfile } from "./0013-household-profile.js";

/**
 * Every migration in order. A new migration is one file plus one line here; numbers are
 * assigned in the task brief so parallel branches do not clash.
 */
export const MIGRATIONS: readonly Migration[] = [
  pairingSessions,
  coreSchema,
  betLocks,
  cardNotices,
  gemmaCards,
  cardPhotos,
  settleProgress,
  cardSunset,
  laundryPlan,
  rescue,
  householdProfile,
];
