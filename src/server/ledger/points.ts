import type { LedgerDeps } from "./deps.js";

/**
 * The sum of every final settlement's points (AC-009.4), plus the points of advice followed
 * (AC-021.3: Wash today is not a bet, so its +5 is stored on the planner card).
 */
export function pointsTotal(deps: Pick<LedgerDeps, "db">): number {
  return deps.db
    .prepare<[], { total: number }>(
      `SELECT COALESCE((SELECT SUM(points) FROM settlements WHERE final = 1), 0)
            + COALESCE((SELECT SUM(advice_points) FROM cards), 0) AS total`,
    )
    .get()!.total;
}
