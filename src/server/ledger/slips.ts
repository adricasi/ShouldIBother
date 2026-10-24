import { getProgress } from "./settle-progress.js";
import { cashOutReceiptOf, receiptOf } from "./receipt.js";
import { listSettlingBets, markDueBets, viewsOf } from "./bets.js";
import type { LedgerDeps } from "./deps.js";
import type { BetRow, CardRow, CashOutRow, SettlementRow } from "./rows.js";

/** The most recent settled bets Slips lists; older ones stay in the database for Score. */
const MAX_SETTLED = 100;

/**
 * The three groups of Slips (REQ-007). Settle now and Waiting are decided here, at read time,
 * from the clock and the bet's settle time (AC-007.2): a bet whose settle time has come is
 * listed under Settle now even if the 60 s scheduler has not marked it due yet, and whatever step
 * of the state machine it is in (`due`, `awaiting_weather`, `awaiting_gemma`).
 */
export function getSlips(deps: LedgerDeps) {
  const now = deps.now();
  // Due is decided at read time, like on Today, so the group below never lags the scheduler.
  // This read therefore writes, by design: `markDueBets` is idempotent and only moves open → due.
  markDueBets(deps.db, now);
  const settling = listSettlingBets(deps);
  const isReady = (bet: BetRow): boolean => bet.settle_at <= now;

  const settleNow = viewsOf(deps, settling.filter(isReady));
  const waiting = viewsOf(
    deps,
    settling.filter((bet) => !isReady(bet)),
  ).map((bet) => ({ ...bet, time_left_ms: Date.parse(bet.settle_at) - now }));

  const settledRows = deps.db
    .prepare<[number], BetRow>(
      `SELECT b.* FROM bets b JOIN settlements s ON s.bet_id = b.id AND s.final = 1
       WHERE b.status = 'settled' ORDER BY s.settled_at DESC, b.id DESC LIMIT ?`,
    )
    .all(MAX_SETTLED);
  const settlementOf = deps.db.prepare<[number], SettlementRow>(
    "SELECT * FROM settlements WHERE bet_id = ? AND final = 1 ORDER BY id DESC LIMIT 1",
  );
  const cardOf = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?");
  const settledWins = viewsOf(deps, settledRows).map((view, index) => {
    // The decision that priced the bet is read once: it goes on the receipt, not on the bet too.
    const { decision: pricing, ...bet } = view;
    const settlement = settlementOf.get(bet.id)!;
    return {
      at: settlement.settled_at,
      bet: {
        ...bet,
        result: {
          verdict: settlement.verdict,
          points: settlement.points,
          evidence: settlement.evidence,
          settled_at: new Date(settlement.settled_at).toISOString(),
        },
        /** The PAID OUT receipt or the loss screen of this bet (AC-010.1, AC-010.2). */
        receipt: receiptOf(
          deps,
          settledRows[index]!,
          cardOf.get(bet.card_id)!,
          settlement,
          getProgress(deps.db, bet.id),
          pricing,
        ),
      },
    };
  });

  // Cashed-out bets are closed at -10 (AC-022.2): listed with the settled ones, newest first.
  const cashedOutRows = deps.db
    .prepare<[number], BetRow>(
      `SELECT b.* FROM bets b JOIN cash_outs c ON c.bet_id = b.id
       WHERE b.status = 'cashed_out' ORDER BY c.cashed_out_at DESC, b.id DESC LIMIT ?`,
    )
    .all(MAX_SETTLED);
  const cashOutOf = deps.db.prepare<[number], CashOutRow>(
    "SELECT * FROM cash_outs WHERE bet_id = ?",
  );
  const cashedOut = viewsOf(deps, cashedOutRows).map((view, index) => {
    const { decision: pricing, ...bet } = view;
    const cashOut = cashOutOf.get(bet.id)!;
    return {
      at: cashOut.cashed_out_at,
      bet: {
        ...bet,
        result: {
          verdict: "cash_out",
          points: cashOut.points,
          evidence: "none",
          settled_at: new Date(cashOut.cashed_out_at).toISOString(),
        },
        receipt: cashOutReceiptOf(
          deps,
          cashedOutRows[index]!,
          cardOf.get(bet.card_id)!,
          cashOut,
          pricing,
        ),
      },
    };
  });
  const settled = [...settledWins, ...cashedOut]
    .sort((a, b) => b.at - a.at || b.bet.id - a.bet.id)
    .slice(0, MAX_SETTLED)
    .map((entry) => entry.bet);

  return {
    now: new Date(now).toISOString(),
    settle_now: settleNow,
    waiting,
    settled,
  };
}

export type SlipsView = ReturnType<typeof getSlips>;
