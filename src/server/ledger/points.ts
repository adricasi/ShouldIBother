import type { LedgerDeps } from "./deps.js";

/**
 * The points total from the stored rows: every final settlement (AC-009.4), plus the points of
 * advice followed (AC-021.3: Wash today is not a bet, so its +5 is stored on the planner card),
 * plus every cash-out (AC-022.2: a cash-out has no verdict, so it sits in its own table). With
 * the `laundryPlanner` and `rescue` flags never on, the last two terms are 0.
 */
export function pointsTotal(deps: Pick<LedgerDeps, "db">): number {
  return deps.db
    .prepare<[], { total: number }>(
      `SELECT COALESCE((SELECT SUM(points) FROM settlements WHERE final = 1), 0)
            + COALESCE((SELECT SUM(points) FROM cash_outs), 0)
            + COALESCE((SELECT SUM(advice_points) FROM cards), 0) AS total`,
    )
    .get()!.total;
}
