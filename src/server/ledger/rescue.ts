import { nameOfBand, oddsOfBand, type Band, type BandTable } from "../../domain/bands.js";
import { LAUNDRY_PLAN, isChoreType, type ChoreType } from "../../domain/chores.js";
import { PLAN_FORECAST_HOURS, planBetWindow } from "../../domain/laundry-plan.js";
import { CASH_OUT_POINTS } from "../../domain/points.js";
import { bandDroppedEnough } from "../../domain/rescue.js";
import { bandTable, ruleQuote, safetyAlert } from "../../domain/rules/index.js";
import { WeatherUnavailableError, type Forecast } from "../weather/client.js";
import { HttpError } from "../problem.js";

import { cardLocationOf } from "./card-location.js";
import { unlockAfterCommit } from "./achievements.js";
import { ruleWindowAt } from "./chore-rules.js";
import type { LedgerDeps } from "./deps.js";
import { cashOutReceiptOf, type Receipt } from "./receipt.js";
import type { BetRow, CardRow, CashOutRow, RescueCheckRow } from "./rows.js";

/**
 * How often an open bet's forecast is looked at again (AC-022.1: at least every hour). Half an
 * hour, so a skipped tick, or a forecast served from the 1 h cache, cannot stretch the gap past
 * the hour.
 */
export const RESCUE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** How far ahead the forecast is read: the planner's four days, the longest a bet can reach. */
const FORECAST_HOURS = PLAN_FORECAST_HOURS;

/**
 * The chore whose rule prices a card's bet: its own, or the line-dry rule for a Skip today bet
 * (REQ-021), which is judged on the line-dry outcome label.
 */
export function rescueRuleChore(choreType: string): ChoreType | undefined {
  if (isChoreType(choreType)) {
    return choreType;
  }
  return choreType === LAUNDRY_PLAN ? "laundry_line" : undefined;
}

/**
 * The part of a bet's rule window that is still to come: from now (or the window's start, if it
 * has not begun) to the window's end. Null once the window is over, when there is nothing left to
 * rescue. The window is the one the bet's card was priced on (anchored on the placing time, with
 * the laundry card's stored sunset), so the rule band here means the same as the band on the bet.
 * A Skip today bet is about the drying hours of the day the planner chose, the window it is
 * judged on (`planBetWindow`).
 */
export function remainingWindow(
  bet: BetRow,
  card: Pick<CardRow, "chore_type" | "sunset_at">,
  nowMs: number,
): { fromMs: number; toMs: number } | null {
  const chore = rescueRuleChore(card.chore_type);
  if (chore === undefined) {
    return null;
  }
  const window =
    card.chore_type === LAUNDRY_PLAN
      ? planBetWindow(bet.settle_at)
      : ruleWindowAt(chore, bet.placed_at, bet.settle_at, card.sunset_at ?? undefined);
  const fromMs = Math.max(window.fromMs, nowMs);
  return fromMs < window.toMs ? { fromMs, toMs: window.toMs } : null;
}

interface CheckCandidate extends BetRow {
  readonly chore_type: string;
  readonly card_sunset_at: number | null;
  readonly location_lat: number | null;
  readonly location_lon: number | null;
}

/**
 * The rescue check (AC-022.1), run by the scheduler while the `rescue` flag is on: for each open
 * bet on doing nothing that has not been looked at for 30 minutes, the rule band of the remaining
 * window is computed from the forecast, without Gemma. The alert goes up when it is two or more
 * bands below the bet's band, or when the fixed heat, frost or storm backstop crosses its limit in
 * that window (safety is never a bet). The answer replaces the bet's previous check. When the
 * forecast cannot be fetched, nothing is written and the next tick tries again; the slip keeps
 * showing the last check with its time. Returns how many bets were checked.
 */
export async function runRescueChecks(deps: LedgerDeps): Promise<number> {
  const now = deps.now();
  const due = deps.db
    .prepare<[number, number], CheckCandidate>(
      `SELECT b.*, c.chore_type AS chore_type, c.sunset_at AS card_sunset_at,
              c.location_lat AS location_lat, c.location_lon AS location_lon
       FROM bets b JOIN cards c ON c.id = b.card_id
       LEFT JOIN rescue_checks r ON r.bet_id = b.id
       WHERE b.kind = 'do_nothing' AND b.status = 'open' AND b.settle_at > ?
         AND (r.checked_at IS NULL OR r.checked_at <= ?)
       ORDER BY b.settle_at, b.id`,
    )
    .all(now, now - RESCUE_CHECK_INTERVAL_MS);
  if (due.length === 0) {
    return 0;
  }
  // One forecast per place: a bet is checked where it was priced, even if the household moved
  // since (onboarding, AC-014.1). Usually one place; null marks a place whose forecast is down.
  const forecasts = new Map<string, Forecast | null>();
  for (const bet of due) {
    const key = `${String(bet.location_lat)}|${String(bet.location_lon)}`;
    if (forecasts.has(key)) {
      continue;
    }
    try {
      forecasts.set(
        key,
        await deps.weather.getForecast({
          fromMs: now,
          hours: FORECAST_HOURS,
          ...cardLocationOf(bet),
        }),
      );
    } catch (error) {
      if (error instanceof WeatherUnavailableError) {
        deps.log({ event: "rescue_check_skipped", reason: "forecast_unavailable" });
        forecasts.set(key, null);
        continue;
      }
      throw error;
    }
  }
  const table = bandTable(deps.rules);
  // The forecast took time: the bets may have changed meanwhile (cashed out, undone, deleted, or
  // past their settle time). Each row is therefore written only if its bet is still open and
  // ahead of its settle time, by the INSERT itself, in one synchronous transaction with no await.
  // A bet that went away is skipped; it can neither abort the pass nor leave a row behind.
  const save = deps.db.prepare(
    `INSERT INTO rescue_checks (bet_id, checked_at, forecast_at, rule_band, alert, reason)
     SELECT @bet_id, @checked_at, @forecast_at, @rule_band, @alert, @reason
     WHERE EXISTS (SELECT 1 FROM bets WHERE id = @bet_id AND kind = 'do_nothing'
                   AND status = 'open' AND settle_at > @checked_at)
     ON CONFLICT (bet_id) DO UPDATE SET checked_at = excluded.checked_at,
       forecast_at = excluded.forecast_at, rule_band = excluded.rule_band,
       alert = excluded.alert, reason = excluded.reason`,
  );
  const checkedAt = deps.now();
  return deps.db.transaction((): number => {
    let checked = 0;
    for (const bet of due) {
      const forecast = forecasts.get(`${String(bet.location_lat)}|${String(bet.location_lon)}`);
      if (forecast === undefined || forecast === null) {
        continue;
      }
      const window = remainingWindow(
        bet,
        { chore_type: bet.chore_type, sunset_at: bet.card_sunset_at },
        checkedAt,
      );
      const chore = rescueRuleChore(bet.chore_type);
      if (window === null || chore === undefined) {
        continue;
      }
      // The backstop is looked at first and needs no complete window: a missing hour cannot hide
      // a limit that the hours present already cross (safety is never a bet).
      const backstop = safetyAlert(forecast.hours, window.fromMs, window.toMs, deps.rules);
      const rule = ruleQuote(chore, forecast.hours, window.fromMs, window.toMs, deps.rules);
      if (rule === null && backstop === null) {
        // The forecast does not cover the remaining window: no false odds, so no new check.
        continue;
      }
      const dropped = rule !== null && bandDroppedEnough(bet.band, rule.band);
      const reason =
        dropped || backstop !== null
          ? alertText(table, {
              betBand: bet.band,
              ruleBand: dropped ? rule.band : null,
              backstop: backstop?.reason ?? null,
            })
          : null;
      checked += save.run({
        bet_id: bet.id,
        checked_at: checkedAt,
        forecast_at: forecast.fetchedAt,
        rule_band: rule?.band ?? null,
        alert: reason === null ? 0 : 1,
        reason,
      }).changes;
    }
    return checked;
  })();
}

function alertText(
  table: BandTable,
  input: {
    readonly betBand: Band;
    /** The rule band when it fell far enough below the bet's band; null when it did not. */
    readonly ruleBand: Band | null;
    readonly backstop: string | null;
  },
): string {
  const words = (band: Band): string =>
    `${nameOfBand(table, band)} (${String(oddsOfBand(table, band))}%)`;
  const parts: string[] = [];
  if (input.ruleBand !== null) {
    parts.push(
      `The forecast turned against this bet: ${words(input.ruleBand)} for the rest of the window, down from ${words(input.betBand)} when you bet.`,
    );
  }
  if (input.backstop !== null) {
    parts.push(`Safety: ${input.backstop} Doing the chore now is the safe choice.`);
  }
  return parts.join(" ");
}

/** What a slip shows about rescue while a bet waits (flag on only). */
export interface RescueView {
  /** True while the bet is open and its settle time is ahead: it can be folded for a small cost. */
  readonly can_cash_out: boolean;
  readonly cash_out_points: number;
  /** The rescue alert, when the last check found the forecast turned against the bet. */
  readonly alert: {
    readonly text: string;
    /** Null when the forecast did not cover the window and only the safety backstop fired. */
    readonly rule_band: Band | null;
    readonly rule_band_name: string | null;
    readonly rule_odds: number | null;
    readonly checked_at: string;
    readonly forecast_at: string;
  } | null;
  /** When the forecast was last re-checked; null before the first check. */
  readonly checked_at: string | null;
}

/** The rescue part of a bet's view; undefined when the bet is not one that can wait for rescue. */
export function rescueView(
  deps: Pick<LedgerDeps, "db" | "rules" | "flags" | "now">,
  bet: BetRow,
): RescueView | undefined {
  if (!deps.flags.rescue || !canCashOut(bet, deps.now())) {
    return undefined;
  }
  const check = deps.db
    .prepare<[number], RescueCheckRow>("SELECT * FROM rescue_checks WHERE bet_id = ?")
    .get(bet.id);
  const table = bandTable(deps.rules);
  return {
    can_cash_out: true,
    cash_out_points: CASH_OUT_POINTS,
    alert:
      check === undefined || check.alert !== 1 || check.reason === null
        ? null
        : {
            text: check.reason,
            rule_band: check.rule_band,
            rule_band_name: check.rule_band === null ? null : nameOfBand(table, check.rule_band),
            rule_odds: check.rule_band === null ? null : oddsOfBand(table, check.rule_band),
            checked_at: new Date(check.checked_at).toISOString(),
            forecast_at: new Date(check.forecast_at).toISOString(),
          },
    checked_at: check === undefined ? null : new Date(check.checked_at).toISOString(),
  };
}

/**
 * A bet can be cashed out while it is open on doing nothing and its settle time is ahead. After
 * the settle time the weather is recorded and the judge decides: folding then would be choosing
 * the result with the evidence in hand. A do-it decision is not a stake, so there is nothing to
 * fold.
 */
export function canCashOut(bet: BetRow, nowMs: number): boolean {
  return bet.kind === "do_nothing" && bet.status === "open" && bet.settle_at > nowMs;
}

/**
 * Cash-out (AC-022.2): settles the bet at -10 points with no savings, whatever the odds and
 * whether or not an alert is up. The bet goes `open → cashed_out` and its row in `cash_outs` is
 * written in the same transaction; the odds and payouts locked on the bet are not touched.
 */
export function cashOutBet(
  deps: Pick<LedgerDeps, "db" | "rules" | "now" | "flags"> & Partial<Pick<LedgerDeps, "log">>,
  betId: number,
): { state: "cashed_out"; receipt: Receipt } {
  const now = deps.now();
  const cash = deps.db.transaction((): { bet: BetRow; row: CashOutRow } => {
    const bet = deps.db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(betId);
    if (bet === undefined) {
      throw new HttpError(404, "Bet not found");
    }
    if (bet.kind !== "do_nothing") {
      throw new HttpError(409, "Only a bet on doing nothing can be cashed out");
    }
    if (bet.status === "cashed_out") {
      throw new HttpError(409, "This bet was already cashed out");
    }
    if (bet.status === "undone") {
      throw new HttpError(409, "This bet was undone");
    }
    if (!canCashOut(bet, now)) {
      throw new HttpError(
        409,
        "This bet can no longer be cashed out",
        "Once the settle time has come, settle it instead.",
      );
    }
    const moved = deps.db
      .prepare("UPDATE bets SET status = 'cashed_out' WHERE id = ? AND status = 'open'")
      .run(bet.id).changes;
    if (moved !== 1) {
      throw new HttpError(409, "This bet can no longer be cashed out");
    }
    const alertShowing = deps.db
      .prepare<[number], { alert: number }>("SELECT alert FROM rescue_checks WHERE bet_id = ?")
      .get(bet.id)?.alert;
    // The check was only there to raise the alert; whether it was up is kept on the cash-out.
    deps.db.prepare("DELETE FROM rescue_checks WHERE bet_id = ?").run(bet.id);
    deps.db
      .prepare(
        "INSERT INTO cash_outs (bet_id, points, cashed_out_at, alert_showing) VALUES (?, ?, ?, ?)",
      )
      .run(bet.id, CASH_OUT_POINTS, now, alertShowing === 1 ? 1 : 0);
    return {
      bet: { ...bet, status: "cashed_out" },
      row: {
        bet_id: bet.id,
        points: CASH_OUT_POINTS,
        cashed_out_at: now,
        alert_showing: alertShowing === 1 ? 1 : 0,
      },
    };
  });
  const { bet, row } = cash.immediate();
  unlockAfterCommit(deps);
  const card = deps.db
    .prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?")
    .get(bet.card_id)!;
  return { state: "cashed_out", receipt: cashOutReceiptOf(deps, bet, card, row) };
}
