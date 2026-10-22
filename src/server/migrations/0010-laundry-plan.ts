import type { Migration } from "../db.js";

/**
 * Migration 0010 (T-022, REQ-021): the laundry planner's plan lives on its card.
 *
 * - `plan`: the planner card's state as JSON (Gemma's suggestion, the four scored days, the answer
 *   to "Need anything washed before <day>?"). Null on every other card, which is how a planner
 *   card is told from a "Coming later" card the listener made for the same chore type.
 * - `advice_followed_at`, `advice_points`: "advice followed" (AC-021.3). Wash today is advice, not
 *   a bet, so its +5 points are kept on the card instead of on a settlement; the points total adds
 *   them. Null until the person follows the advice.
 *
 * Columns on `cards` rather than a table: export, delete (REQ-015) and the card's lifetime already
 * cover them. Nothing existing is rewritten.
 */
export const laundryPlan: Migration = {
  id: 10,
  name: "laundry_plan",
  sql: `
ALTER TABLE cards ADD COLUMN plan TEXT;
ALTER TABLE cards ADD COLUMN advice_followed_at INTEGER;
ALTER TABLE cards ADD COLUMN advice_points INTEGER;
`,
};
