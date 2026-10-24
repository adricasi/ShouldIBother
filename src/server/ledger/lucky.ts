import { RAIN_CHORES } from "../../domain/outcomes.js";
import type { Db } from "../db.js";

export interface LuckyShare {
  /** Settled wins whose lucky flag is known (0 or 1). */
  readonly wins_labelled: number;
  readonly lucky_wins: number;
  /** `lucky_wins / wins_labelled`, or null when no win has a flag. */
  readonly share: number | null;
}

/**
 * The lucky-win share reported separately from calibration (AC-008.6, REQ-020). A win whose
 * `lucky_win` is NULL (the recorded hours could not be labelled) is left out of the numerator and
 * the denominator alike: it is neither lucky nor not lucky.
 */
export function luckyWinShare(db: Db): LuckyShare {
  const row = db
    .prepare<[], { labelled: number; lucky: number | null }>(
      `SELECT COUNT(*) AS labelled, SUM(lucky_win) AS lucky FROM settlements
       WHERE final = 1 AND verdict = 'win' AND lucky_win IS NOT NULL
         AND bet_id NOT IN (
           SELECT b.id FROM bets b JOIN cards c ON c.id = b.card_id
           WHERE c.chore_type IN (${RAIN_CHORES.map((chore) => `'${chore}'`).join(", ")}))`,
    )
    .get()!;
  const lucky = row.lucky ?? 0;
  return {
    wins_labelled: row.labelled,
    lucky_wins: lucky,
    share: row.labelled === 0 ? null : lucky / row.labelled,
  };
}
