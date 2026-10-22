import type { Migration } from "../db.js";

/**
 * Migration 0012 (T-024, REQ-023): the database holds the appeal rules the code relies on.
 *
 * A bet's result is its one final settlement. An appeal adds a second row (`appeal_of` names the
 * first) and, in the same transaction, turns the first row's `final` off, so the total, the
 * savings, the Slips and the receipt always read exactly one verdict per bet:
 *
 * - `settlements_one_final_per_bet`: at most one final row per bet. The appeal turns the first
 *   row off before it inserts the second, because SQLite checks a unique index per statement.
 * - `settlements_one_appeal_per_bet`: a bet is appealed at most once (AC-023.2), even if two
 *   requests arrive together.
 * - `settlements_appeal_same_bet`: an appeal row can only point at a settlement of its own bet,
 *   and only at an original, never at another appeal.
 *
 * Nothing existing is rewritten: before appeals every bet has one original row with final = 1,
 * which satisfies all three rules.
 */
export const appeals: Migration = {
  id: 12,
  name: "appeals",
  sql: `
CREATE UNIQUE INDEX settlements_one_final_per_bet ON settlements (bet_id) WHERE final = 1;
CREATE UNIQUE INDEX settlements_one_appeal_per_bet ON settlements (bet_id) WHERE appeal_of IS NOT NULL;

CREATE TRIGGER settlements_appeal_same_bet
BEFORE INSERT ON settlements
WHEN NEW.appeal_of IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM settlements
   WHERE id = NEW.appeal_of AND bet_id = NEW.bet_id AND appeal_of IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'an appeal must follow the original settlement of the same bet');
END;
`,
};
