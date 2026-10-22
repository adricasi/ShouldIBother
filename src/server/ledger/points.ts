import type { LedgerDeps } from "./deps.js";

/** The sum of every final settlement's points, from the stored rows (AC-009.4). */
export function pointsTotal(deps: Pick<LedgerDeps, "db">): number {
  return deps.db
    .prepare<[], { total: number }>(
      "SELECT COALESCE(SUM(points), 0) AS total FROM settlements WHERE final = 1",
    )
    .get()!.total;
}
