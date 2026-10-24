import type { Migration } from "../db.js";

/**
 * Migration 0018 (T-039, REQ-031): an advice card's state lives on its card.
 *
 * - `advice`: the card's advice as JSON (the rule's advice, Gemma's validated answer with its
 *   window and reason, the decision behind it, the forecast hour the window counts from). Null on
 *   every other card, which is how an advice card is told from the "Coming later" card the
 *   listener makes for the same chore type while the `adviceCards` flag is off.
 *
 * A column on `cards` rather than a table, like the laundry plan (0010): export, delete (REQ-015)
 * and the card's lifetime already cover it. Advice is not a bet, so nothing here touches bets,
 * points or savings. Nothing existing is rewritten.
 */
export const cardAdvice: Migration = {
  id: 18,
  name: "card_advice",
  sql: `
ALTER TABLE cards ADD COLUMN advice TEXT;
`,
};
