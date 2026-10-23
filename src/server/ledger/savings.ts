import { LAUNDRY_PLAN, isChoreType } from "../../domain/chores.js";
import {
  parseSnapshot,
  snapshotFor,
  totalSavings,
  type SavingsSnapshot,
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
  // A won Skip today bet dried the load on the line instead of in the dryer: the line-dry figure
  // for the household's dryer (REQ-021, REQ-011).
  const chore = choreType === LAUNDRY_PLAN ? "laundry_line" : choreType;
  return isChoreType(chore)
    ? JSON.stringify(snapshotFor(deps.savings, chore, deps.household))
    : null;
}

/**
 * What a win would save, shown on a card that offers a do-nothing bet (AC-011.7): the figure of
 * the catalogue and the household baseline of this moment, with its assumption. It is the figure
 * `savingsSnapshotText` would write on a bet placed now, read back, so the two cannot differ.
 * Time is left out when it is 0 (AC-011.4). It is an estimate: nothing is added to any total
 * until a bet wins, and a placed bet shows its own stored snapshot, not this.
 */
export interface SavingsEstimate {
  readonly time_min?: number;
  readonly water_l: number;
  readonly electricity_kwh: number;
  readonly assumption: string;
  readonly basis: SavingsSnapshot["basis"];
}

export function savingsEstimate(deps: SavingsDeps, choreType: string): SavingsEstimate | null {
  const snapshot = parseSnapshot(savingsSnapshotText(deps, choreType));
  if (snapshot === null) {
    return null;
  }
  return {
    ...(snapshot.time_min > 0 ? { time_min: snapshot.time_min } : {}),
    water_l: snapshot.water_l,
    electricity_kwh: snapshot.electricity_kwh,
    assumption: snapshot.assumption,
    basis: snapshot.basis,
  };
}

/**
 * A card view with its savings estimate, when the card still offers a do-nothing bet, as Today
 * decides it: it has a quote whose settle time is ahead and no bet on it that was not undone
 * (AC-011.7). A card that has been bet on shows its bet's own stored figure elsewhere, not a
 * recomputed estimate.
 */
export function withSavingsEstimate<
  T extends { readonly quote: { readonly settle_at: string } | null },
>(
  deps: SavingsDeps & Pick<LedgerDeps, "now">,
  card: { readonly id: number; readonly chore_type: string },
  view: T,
): T & { savings_estimate?: SavingsEstimate } {
  if (view.quote === null || Date.parse(view.quote.settle_at) <= deps.now()) {
    return view;
  }
  const bets = deps.db
    .prepare<[number], { n: number }>(
      "SELECT COUNT(*) AS n FROM bets WHERE card_id = ? AND status != 'undone'",
    )
    .get(card.id)!.n;
  if (bets > 0) {
    return view;
  }
  const estimate = savingsEstimate(deps, card.chore_type);
  return estimate === null ? view : { ...view, savings_estimate: estimate };
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
