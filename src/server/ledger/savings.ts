import { isChoreType } from "../../domain/chores.js";
import {
  parseSnapshot,
  snapshotFor,
  totalSavings,
  type SavingsTotals,
} from "../../domain/savings.js";
import { madridWeekOf, type Week } from "../../domain/week.js";

import type { LedgerDeps } from "./deps.js";

type SavingsDeps = Pick<LedgerDeps, "db" | "household" | "savings">;

/**
 * The snapshot written in a bet's INSERT (design.md, Points and savings): the catalogue figure for
 * the chore and the household baseline of that moment, with its assumption text. Migration 0003
 * makes the column write-once, so the figure of a bet never moves with the config afterwards.
 */
export function savingsSnapshotText(deps: SavingsDeps, choreType: string): string | null {
  return isChoreType(choreType)
    ? JSON.stringify(snapshotFor(deps.savings, choreType, deps.household))
    : null;
}

/**
 * One-time backfill for bets placed before savings existed (the first real bets): every bet whose
 * snapshot is still NULL gets the figure of the current catalogue and baseline. The write-once
 * trigger lets a NULL become a value exactly once, so running this at every start changes nothing
 * the second time. Returns how many bets it filled.
 */
export function backfillSavingsSnapshots(deps: SavingsDeps): number {
  const missing = deps.db
    .prepare<[], { id: number; chore_type: string }>(
      `SELECT b.id, c.chore_type FROM bets b JOIN cards c ON c.id = b.card_id
       WHERE b.savings_snapshot IS NULL`,
    )
    .all();
  const fill = deps.db.prepare(
    "UPDATE bets SET savings_snapshot = ? WHERE id = ? AND savings_snapshot IS NULL",
  );
  let filled = 0;
  deps.db.transaction(() => {
    for (const bet of missing) {
      const text = savingsSnapshotText(deps, bet.chore_type);
      if (text !== null) {
        filled += fill.run(text, bet.id).changes;
      }
    }
  })();
  return filled;
}

/**
 * Savings totals (REQ-011). Wins of bets on doing nothing add their snapshot (AC-011.1); losses,
 * do-it decisions and undone bets add nothing (AC-011.2); every bet and do-it decision placed and
 * not undone costs 30 s of app time (AC-011.3). A bet belongs to the period of its settle time,
 * so a bet placed on Sunday night and settled on Monday counts, whole, in Monday's week. With no
 * period the totals cover every bet.
 */
export function savingsTotals(
  deps: Pick<LedgerDeps, "db">,
  period?: { readonly fromMs: number; readonly toMs: number },
): SavingsTotals {
  const bounds = period === undefined ? [] : [period.fromMs, period.toMs];
  const inPeriod = period === undefined ? "" : "AND b.settle_at >= ? AND b.settle_at < ?";
  const wins = deps.db
    .prepare<number[], { savings_snapshot: string | null }>(
      `SELECT b.savings_snapshot FROM bets b
       JOIN settlements s ON s.bet_id = b.id AND s.final = 1 AND s.verdict = 'win'
       WHERE b.kind = 'do_nothing' AND b.status = 'settled' ${inPeriod}
       ORDER BY b.settle_at, b.id`,
    )
    .all(...bounds)
    .map((row) => parseSnapshot(row.savings_snapshot));
  const placed = deps.db
    .prepare<number[], { n: number }>(
      `SELECT COUNT(*) AS n FROM bets b WHERE b.status != 'undone' ${inPeriod}`,
    )
    .get(...bounds)!.n;
  return totalSavings(wins, placed);
}

export interface WeekSavings {
  readonly from: string;
  readonly to: string;
  readonly totals: SavingsTotals;
}

/** This week's totals on Today, Monday to Sunday in Madrid time (AC-011.6). */
export function weekSavings(deps: Pick<LedgerDeps, "db" | "now">): WeekSavings {
  const week: Week = madridWeekOf(deps.now());
  return {
    from: week.fromDate,
    to: week.toDate,
    totals: savingsTotals(deps, week),
  };
}
