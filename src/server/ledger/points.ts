import type { LedgerDeps } from "./deps.js";

/**
 * The sum of every final settlement's points and every cash-out's points, from the stored rows
 * (AC-009.4, AC-022.2). A cash-out is not a settlement (it has no verdict), so it sits in its own
 * table; with the `rescue` flag never on, that table is empty and the total is the settlements'.
 */
export function pointsTotal(deps: Pick<LedgerDeps, "db">): number {
  return deps.db
    .prepare<[], { total: number }>(
      `SELECT (SELECT COALESCE(SUM(points), 0) FROM settlements WHERE final = 1)
            + (SELECT COALESCE(SUM(points), 0) FROM cash_outs) AS total`,
    )
    .get()!.total;
}
