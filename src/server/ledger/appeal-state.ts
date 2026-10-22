import type { Db } from "../db.js";
import { HttpError } from "../problem.js";

import type { BetRow, SettlementRow } from "./rows.js";

/** Why a bet cannot be appealed, in the words of the 409; undefined when it can (REQ-023). */
export function appealRefusal(
  db: Db,
  bet: Pick<BetRow, "id" | "kind" | "status">,
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
  return undefined;
}

/** Whether the app offers an appeal on this bet now: the flag is on and nothing refuses it. */
export function canAppeal(db: Db, bet: Pick<BetRow, "id" | "kind" | "status">): boolean {
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
