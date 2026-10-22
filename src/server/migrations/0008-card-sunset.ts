import type { Migration } from "../db.js";

/**
 * Migration 0008 (T-013, REQ-016, AC-016.2, AC-008.6): the sunset a "Leave it out tonight" card
 * was priced on. The laundry window runs from sunset to 08:00, so the rule band, the safety
 * backstop and the `lucky_win` label of a bet on the card all start there, not at the moment the
 * bet was placed. It is written when the card is created and never changed: a later forecast
 * moves the sunset by seconds, and a label window that moved after the bet would not be the one
 * the bet was made on. Null on every other card.
 *
 * A column on `cards` rather than on `bets`: the bet reaches its card, and the `bets` table is the
 * locked one (migration 0003). One nullable column, no rewrite of existing rows.
 */
export const cardSunset: Migration = {
  id: 8,
  name: "card_sunset",
  sql: `
ALTER TABLE cards ADD COLUMN sunset_at INTEGER;

CREATE TRIGGER cards_write_once_sunset_at
BEFORE UPDATE OF sunset_at ON cards
WHEN OLD.sunset_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cards: sunset_at cannot be updated once written');
END;
`,
};
