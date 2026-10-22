import type { Migration } from "../db.js";

/**
 * Migration 0014 (T-026, REQ-025): the achievements a household has unlocked, behind the `ranks`
 * flag. One row per achievement, written once when its condition is first met (AC-025.2);
 * `INSERT OR IGNORE` on the primary key keeps it once. `unlocked_at` is the time of the event
 * that met the condition (the settlement or the cash-out), not the time the row was written.
 *
 * The rank needs no table: it is a pure function of the points total. The row does not point at
 * a bet, so deleting a bet's data (AC-015.2) does not take back an achievement already earned.
 * Only a new table: existing rows are untouched.
 */
export const achievements: Migration = {
  id: 14,
  name: "achievements",
  sql: `
CREATE TABLE achievements (
  id          TEXT PRIMARY KEY CHECK (id IN (
    'first_nap', 'cloud_whisperer', 'sky_freeloader', 'knows_when_to_fold'
  )),
  unlocked_at INTEGER NOT NULL
);
`,
};
