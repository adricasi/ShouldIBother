import { bandTable } from "../../domain/rules/index.js";
import { UNDO_WINDOW_MS } from "../../domain/chores.js";
import type { Db } from "../db.js";
import { HttpError } from "../problem.js";

import { latestQuote } from "./cards.js";
import type { LedgerDeps } from "./deps.js";
import type { BetRow, CardRow, QuoteRow } from "./rows.js";
import { betView, type BetView } from "./views.js";

/**
 * The minimal bet insert of the walking skeleton: locks the quote the user saw, named by
 * `quoteId`, and refuses when it is no longer the card's latest (AC-006.1, AC-006.2); stores
 * the rule band next to it (AC-004.2). Undo, do-it and the state machine are T-008.
 */
export function placeDoNothingBet(deps: LedgerDeps, cardId: number, quoteId: number): BetView {
  const now = deps.now();
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  if (card.kind !== "weather") {
    throw new HttpError(409, "No bet on this card");
  }
  const quote = latestQuote(deps, cardId);
  if (quote === undefined) {
    throw new HttpError(409, "No odds on this card yet");
  }
  if (quote.id !== quoteId) {
    // The card moved on (Gemma's odds replaced the rule's, say): the bet locks only what was seen.
    throw new HttpError(
      409,
      "The odds changed",
      "Look at the card again and confirm the new odds.",
    );
  }
  if (quote.settle_at <= now) {
    throw new HttpError(409, "These odds are out of date", "Create a new card.");
  }
  const ruleQuote = deps.db
    .prepare<[number], QuoteRow>(
      "SELECT * FROM quotes WHERE card_id = ? AND source = 'rule' ORDER BY id DESC LIMIT 1",
    )
    .get(cardId);
  if (ruleQuote === undefined) {
    throw new HttpError(409, "No rule odds on this card");
  }

  const place = deps.db.transaction((): BetRow => {
    const existing = deps.db
      .prepare<[number], { n: number }>(
        "SELECT COUNT(*) AS n FROM bets WHERE card_id = ? AND status != 'undone'",
      )
      .get(cardId)!;
    if (existing.n > 0) {
      throw new HttpError(409, "A bet is already placed on this card");
    }
    const id = Number(
      deps.db
        .prepare(
          `INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, gemma_band, rule_band,
             placed_at, undo_until, settle_at, status)
           VALUES (?, 'do_nothing', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(
          cardId,
          quote.band,
          quote.odds,
          quote.source,
          quote.reason,
          quote.source === "gemma" ? quote.band : null,
          ruleQuote.band,
          now,
          now + UNDO_WINDOW_MS,
          quote.settle_at,
        ).lastInsertRowid,
    );
    return deps.db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(id)!;
  });
  return betView(place(), card, bandTable(deps.rules));
}

/** The scheduler's step: an open bet whose settle time has come is due (design.md, state machine). */
export function markDueBets(db: Db, nowMs: number): number {
  return db
    .prepare("UPDATE bets SET status = 'due' WHERE status = 'open' AND settle_at <= ?")
    .run(nowMs).changes;
}

export function listBetsWithStatus(deps: LedgerDeps, status: "open" | "due"): BetView[] {
  const rows = deps.db
    .prepare<[string], BetRow>("SELECT * FROM bets WHERE status = ? ORDER BY settle_at, id")
    .all(status);
  const table = bandTable(deps.rules);
  const cardOf = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?");
  return rows.map((row) => betView(row, cardOf.get(row.card_id)!, table));
}
