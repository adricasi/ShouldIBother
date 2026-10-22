import { CHORES, isChoreType } from "../../domain/chores.js";
import { MULTIPLIER, pointsFor } from "../../domain/points.js";
import { judgeBet } from "../gemma/judge.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { HttpError } from "../problem.js";

import { markDueBets } from "./bets.js";

import type { LedgerDeps } from "./deps.js";
import type { BetRow, CardRow } from "./rows.js";

/** The sum of every final settlement's points, from the stored rows (AC-009.4). */
export function pointsTotal(deps: Pick<LedgerDeps, "db">): number {
  return deps.db
    .prepare<[], { total: number }>(
      "SELECT COALESCE(SUM(points), 0) AS total FROM settlements WHERE final = 1",
    )
    .get()!.total;
}

export interface Settled {
  readonly bet_id: number;
  readonly verdict: string;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly evidence_kind: "tap";
  readonly multiplier: number;
  readonly points: number;
  readonly total_points: number;
}

/**
 * Settles a due do-nothing bet from one tap: the Gemma judge gives the verdict and code turns it
 * into points (REQ-008, REQ-009). The rule never settles a bet: if the judge is offline, times
 * out or answers badly, the bet stays due and the caller gets a 503 (AC-008.8, T-009 adds the
 * `awaiting_gemma` state and retries).
 */
export async function settleByTap(
  deps: LedgerDeps,
  betId: number,
  answerId: string,
): Promise<Settled> {
  // A tap right after the settle time must not wait for the next scheduler pass.
  markDueBets(deps.db, deps.now());
  const bet = deps.db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(betId);
  if (bet === undefined) {
    throw new HttpError(404, "Bet not found");
  }
  if (bet.status !== "due") {
    throw new HttpError(
      409,
      bet.status === "open" ? "This bet is not ready to settle yet" : "This bet cannot be settled",
    );
  }
  if (bet.kind !== "do_nothing") {
    throw new HttpError(409, "Only bets on doing nothing can be settled here");
  }
  const card = deps.db
    .prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?")
    .get(bet.card_id)!;
  const chore = isChoreType(card.chore_type) ? CHORES[card.chore_type] : undefined;
  if (chore === undefined) {
    throw new HttpError(409, "This chore cannot be settled yet");
  }
  if (!chore.tapAnswers.some((answer) => answer.id === answerId)) {
    throw new HttpError(400, "Unknown answer");
  }

  let judged;
  try {
    judged = await judgeBet(deps.gemma, {
      chore,
      odds: bet.odds,
      answerId,
      betId: bet.id,
      cardId: bet.card_id,
    });
  } catch (error) {
    if (error instanceof JobQueueFullError) {
      throw new HttpError(503, "Gemma is busy", "The bet stays open; try again in a minute.");
    }
    throw error;
  }
  if (!judged.ok) {
    // The runner logged the failed decision (REQ-028).
    throw new HttpError(
      503,
      "Gemma could not judge this bet yet",
      "The bet stays open for settling; try again when Gemma is back.",
    );
  }

  const multiplier = MULTIPLIER.tap;
  const points = pointsFor({
    kind: bet.kind,
    verdict: judged.verdict,
    odds: bet.odds,
    evidence: "tap",
  });
  const commit = deps.db.transaction((): void => {
    // The status guard makes a second tap on the same bet fail instead of settling it twice.
    const moved = deps.db
      .prepare("UPDATE bets SET status = 'settled' WHERE id = ? AND status = 'due'")
      .run(bet.id).changes;
    if (moved !== 1) {
      throw new HttpError(409, "This bet cannot be settled");
    }
    deps.db
      .prepare(
        `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, lucky_win, weather,
           decision_id, points, settled_at, appeal_of, final)
         VALUES (?, 'tap', ?, ?, NULL, NULL, ?, ?, ?, NULL, 1)`,
      )
      .run(bet.id, multiplier, judged.verdict, judged.decisionId, points, deps.now());
  });
  commit();

  return {
    bet_id: bet.id,
    verdict: judged.verdict,
    reason: judged.reason,
    evidence: judged.evidence,
    evidence_kind: "tap",
    multiplier,
    points,
    total_points: pointsTotal(deps),
  };
}
