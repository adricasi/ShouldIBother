import { canUndo, SETTLING_STATUSES, type BetStatus } from "../../domain/bet-state.js";
import { UNDO_WINDOW_MS } from "../../domain/chores.js";
import { bandTable } from "../../domain/rules/index.js";
import type { Db } from "../db.js";
import { HttpError } from "../problem.js";

import { latestQuote } from "./quotes.js";
import type { LedgerDeps } from "./deps.js";
import { currentPhoto, withoutPhotoQuote } from "./photo-view.js";
import { savingsSnapshotText } from "./savings.js";
import { getProgress } from "./settle-progress.js";
import type { BetRow, CardRow, QuoteRow } from "./rows.js";
import { betView, type BetView } from "./views.js";

export type BetKind = BetRow["kind"];

/**
 * Places a bet on doing nothing, or records the "I'll do it" decision (REQ-006). Either way the
 * quote the user saw, named by `quoteId`, is copied onto the bet and locked (AC-006.1, AC-006.3);
 * it is refused when that is no longer the card's latest quote. Later forecasts and Gemma
 * answers cannot reach the bet, and the database refuses updates to the locked columns
 * (migration 0003, AC-006.2). The rule band is stored next to it (AC-004.2).
 */
export function placeBet(
  deps: LedgerDeps,
  cardId: number,
  quoteId: number,
  kind: BetKind,
): BetView {
  const now = deps.now();
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  if (card.kind === "alert") {
    // AC-012.2: a "Do it now" alert has no bet action, and the API enforces it too.
    throw new HttpError(409, "No bet on an alert", card.alert_reason ?? "Do this one now.");
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

  // A bet on Gemma's quote records which model and prompt made it, in the INSERT: migration 0003
  // makes both columns write-once (REQ-028).
  const decision =
    quote.source === "gemma" && quote.decision_id !== null
      ? deps.db
          .prepare<
            [number],
            { model: string; model_digest: string | null; prompt_version: string }
          >("SELECT model, model_digest, prompt_version FROM gemma_decisions WHERE id = ?")
          .get(quote.decision_id)
      : undefined;
  const modelVersion =
    decision === undefined
      ? null
      : decision.model_digest === null
        ? decision.model
        : `${decision.model}@${decision.model_digest}`;

  // AC-005.5: a bet on a card with a photo also stores the band without it, for the photo
  // ablation. It is written here, in the INSERT, because migration 0003 makes it write-once.
  const bandWithoutPhoto =
    currentPhoto(deps.db, cardId) === undefined
      ? null
      : (withoutPhotoQuote(deps.db, cardId, quote.with_photo === 1 ? quote.id : null)?.band ??
        null);

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
             band_without_photo, model_version, prompt_version, savings_snapshot, placed_at,
             undo_until, settle_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(
          cardId,
          kind,
          quote.band,
          quote.odds,
          quote.source,
          quote.reason,
          quote.source === "gemma" ? quote.band : null,
          ruleQuote.band,
          bandWithoutPhoto,
          modelVersion,
          decision?.prompt_version ?? null,
          savingsSnapshotText(deps, card.chore_type),
          now,
          now + UNDO_WINDOW_MS,
          quote.settle_at,
        ).lastInsertRowid,
    );
    return deps.db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(id)!;
  });
  return betView(place(), card, bandTable(deps.rules), now);
}

/**
 * Undo within 5 minutes of placing (AC-006.4, A-9): the bet gets the status `undone`, scores no
 * points and keeps its row so net time can leave it out later (REQ-011). After the window, or
 * once the bet is no longer open, the bet is locked and the answer is 409 (AC-006.5).
 */
export function undoBet(deps: LedgerDeps, betId: number): BetView {
  const now = deps.now();
  // Due is decided at read time everywhere (Today, Slips, settle), so a bet whose settle time
  // passed inside its 5 minutes is refused here for the same reason it is listed as due.
  markDueBets(deps.db, now);
  const undo = deps.db.transaction((): BetRow => {
    const bet = deps.db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(betId);
    if (bet === undefined) {
      throw new HttpError(404, "Bet not found");
    }
    if (bet.status === "undone") {
      throw new HttpError(409, "This bet was already undone");
    }
    if (!canUndo({ status: bet.status, undoUntil: bet.undo_until }, now)) {
      throw new HttpError(
        409,
        "This bet is locked",
        bet.status === "open"
          ? "Undo only works in the first 5 minutes."
          : "It is past the point where it can be undone.",
      );
    }
    const moved = deps.db
      .prepare("UPDATE bets SET status = 'undone' WHERE id = ? AND status = 'open'")
      .run(bet.id).changes;
    if (moved !== 1) {
      throw new HttpError(409, "This bet is locked");
    }
    return { ...bet, status: "undone" };
  });
  const bet = undo();
  const card = deps.db
    .prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?")
    .get(bet.card_id)!;
  return betView(bet, card, bandTable(deps.rules), now);
}

/** The scheduler's step: an open bet whose settle time has come is due (design.md, state machine). */
export function markDueBets(db: Db, nowMs: number): number {
  return db
    .prepare("UPDATE bets SET status = 'due' WHERE status = 'open' AND settle_at <= ?")
    .run(nowMs).changes;
}

/** Bets whose settle time has come and that are not settled yet, in any step of the machine. */
export function listDueBets(deps: LedgerDeps): BetView[] {
  return viewsOf(
    deps,
    deps.db
      .prepare<[number], BetRow>(
        `SELECT * FROM bets WHERE status IN ('due', 'awaiting_weather', 'awaiting_gemma')
         AND settle_at <= ? ORDER BY settle_at, id`,
      )
      .all(deps.now()),
  );
}

export function listBetsWithStatus(deps: LedgerDeps, status: "open" | "due"): BetView[] {
  return viewsOf(
    deps,
    deps.db
      .prepare<[string], BetRow>("SELECT * FROM bets WHERE status = ? ORDER BY settle_at, id")
      .all(status),
  );
}

/** Bets still waiting for a verdict, in any step of the machine, by settle time. */
export function listSettlingBets(deps: LedgerDeps): BetRow[] {
  const marks = SETTLING_STATUSES.map(() => "?").join(", ");
  return deps.db
    .prepare<BetStatus[], BetRow>(
      `SELECT * FROM bets WHERE status IN (${marks}) ORDER BY settle_at, id`,
    )
    .all(...SETTLING_STATUSES);
}

export function viewsOf(deps: LedgerDeps, rows: readonly BetRow[]): BetView[] {
  const table = bandTable(deps.rules);
  const now = deps.now();
  const cardOf = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?");
  return rows.map((row) =>
    betView(row, cardOf.get(row.card_id)!, table, now, getProgress(deps.db, row.id)),
  );
}
