import type { Migration } from "../db.js";

/**
 * Migration 0017 (T-035, REQ-028, AC-028.4): the Gemma decision that priced a bet. A bet is placed
 * on a quote, and a quote of Gemma's points at the decision that made it, but the bet kept only
 * the model and prompt versions, so "How Gemma decided" could not say which decision it was when
 * the card had more than one (a Retry, a photo). The bet now records it at placement.
 *
 * Nullable: NULL on every bet placed before this migration and on every bet on rule odds, which
 * Gemma did not price (existing rows are not rewritten and show no disclosure). It is set in the
 * INSERT and then write-once: it can go from a decision to NULL (the decision was deleted with
 * its photo, AC-015.2: the foreign key does that) but never to another decision.
 */
export const betDecision: Migration = {
  id: 17,
  name: "bet_decision",
  sql: `
ALTER TABLE bets ADD COLUMN decision_id INTEGER REFERENCES gemma_decisions(id) ON DELETE SET NULL;

CREATE TRIGGER bets_write_once_decision_id
BEFORE UPDATE OF decision_id ON bets
WHEN OLD.decision_id IS NOT NULL AND NEW.decision_id IS NOT NULL AND NEW.decision_id != OLD.decision_id
BEGIN
  SELECT RAISE(ABORT, 'bets: the locked columns of a bet cannot be updated (decision_id)');
END;
`,
};
