import { betChoreSpec } from "../../domain/chores.js";
import { ANSWER_WINDOW_MS } from "../../domain/settlement.js";
import type { Db } from "../db.js";
import { HttpError } from "../problem.js";

import type { BetRow, SettlementRow } from "./rows.js";

/** Why a bet cannot be appealed, in the words of the 409; undefined when it can (REQ-023). */
export function appealRefusal(
  db: Db,
  bet: Pick<BetRow, "id" | "card_id" | "kind" | "status">,
): HttpError | undefined {
  if (bet.kind !== "do_nothing") {
    // A do-it decision is scored on the recorded weather alone: a photo cannot change it.
    return new HttpError(
      409,
      "Only bets on doing nothing can be appealed",
      "An 'I'll do it' decision is scored on the weather record.",
    );
  }
  if (bet.status !== "settled") {
    return new HttpError(409, "Only a settled bet can be appealed");
  }
  const appealed = db
    .prepare<[number], { id: number }>(
      "SELECT id FROM settlements WHERE bet_id = ? AND appeal_of IS NOT NULL",
    )
    .get(bet.id);
  if (appealed !== undefined) {
    // AC-023.2: one appeal per bet; the second verdict is final.
    return new HttpError(
      409,
      "This bet was already appealed",
      "The second verdict is final; there is no second appeal.",
    );
  }
  // The same checks the appeal itself needs, so the receipt never offers one that would get a 409.
  const card = db
    .prepare<[number], { chore_type: string }>("SELECT chore_type FROM cards WHERE id = ?")
    .get(bet.card_id);
  if (
    originalSettlement(db, bet.id) === undefined ||
    card === undefined ||
    betChoreSpec(card.chore_type) === undefined
  ) {
    return new HttpError(409, "This bet cannot be appealed");
  }
  return undefined;
}

/**
 * Whether an appeal decided at `nowMs` pays at most half points: a verdict committed 24 h or more
 * after the settle time pays a win at x0.5 whatever the evidence (AC-008.8, applied to appeals).
 */
export function appealPaysHalf(bet: Pick<BetRow, "settle_at">, nowMs: number): boolean {
  return nowMs >= bet.settle_at + ANSWER_WINDOW_MS;
}

/** Whether the app offers an appeal on this bet now: the flag is on and nothing refuses it. */
export function canAppeal(
  db: Db,
  bet: Pick<BetRow, "id" | "card_id" | "kind" | "status">,
): boolean {
  return appealRefusal(db, bet) === undefined;
}

/** The original settlement of a bet: the verdict an appeal disputes. */
export function originalSettlement(db: Db, betId: number): SettlementRow | undefined {
  return db
    .prepare<[number], SettlementRow>(
      "SELECT * FROM settlements WHERE bet_id = ? AND appeal_of IS NULL",
    )
    .get(betId);
}
