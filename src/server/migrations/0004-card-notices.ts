import type { Migration } from "../db.js";

/**
 * Migration 0004 (T-005, REQ-014, REQ-016, NFR-003): a card that has no odds and no bet action
 * says why in its own words. `cards.notice` carries that text: "No forecast, can't set odds"
 * (AC-014.4), "Not needed this season" (AC-016.5), "Line-dry today is offered 07:00 to 15:00"
 * (AC-016.4). Such cards use the existing kind `coming_later` (no odds, no bet action); a card
 * of that kind without a notice reads "Coming later" (AC-002.3).
 *
 * One nullable column, no rewrite of existing rows. (A new card kind would need the CHECK on
 * `cards.kind` changed, which SQLite can do only by rebuilding the table, and dropping `cards`
 * cascade-deletes its bets, quotes and photos.)
 */
export const cardNotices: Migration = {
  id: 4,
  name: "card_notices",
  sql: `ALTER TABLE cards ADD COLUMN notice TEXT;`,
};
