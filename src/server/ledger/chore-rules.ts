import type { Band } from "../../domain/bands.js";
import { CHORES, clampSettleAt, type ChoreType, type SettleBounds } from "../../domain/chores.js";
import { ruleQuote, type RuleQuote, type RulesConfig } from "../../domain/rules/index.js";
import type { ForecastHour } from "../../domain/weather.js";

/**
 * The window the rule band is computed over when Gemma settles at `settleAtMs`. `nowMs` is the
 * card's creation time (the anchor), not the time of a later retry. Only the plants
 * window follows the settle time (design.md: "now to settle"); the other chores' windows are fixed
 * by the table (line-dry ends at 18:00, whatever the settle time within its bounds).
 */
export function ruleWindowAt(
  chore: ChoreType,
  nowMs: number,
  settleAtMs: number,
): { fromMs: number; toMs: number } {
  const window = CHORES[chore].ruleWindow(nowMs);
  return chore === "plants" ? { fromMs: window.fromMs, toMs: settleAtMs } : window;
}

/** The rule baseline for the final settle time; null when the forecast does not cover it. */
export function ruleQuoteAt(
  chore: ChoreType,
  forecast: readonly ForecastHour[],
  nowMs: number,
  settleAtMs: number,
  config: RulesConfig,
): (RuleQuote & { windowEndMs: number }) | null {
  const window = ruleWindowAt(chore, nowMs, settleAtMs);
  const quote = ruleQuote(chore, forecast, window.fromMs, window.toMs, config);
  return quote === null ? null : { ...quote, windowEndMs: window.toMs };
}

/** The band of the rule baseline, or `fallback` when the forecast does not cover the window. */
export function ruleBandOrFallback(
  chore: ChoreType,
  forecast: readonly ForecastHour[],
  nowMs: number,
  settleAtMs: number,
  config: RulesConfig,
  fallback: Band,
): Band {
  return ruleQuoteAt(chore, forecast, nowMs, settleAtMs, config)?.band ?? fallback;
}

export function settleBoundsOf(chore: ChoreType, nowMs: number): SettleBounds {
  return CHORES[chore].settleBounds(nowMs);
}

/** Gemma proposes `settle_in_hours`; code clamps the settle time into the chore's bounds. */
export function clampSettle(chore: ChoreType, nowMs: number, proposedMs: number): number {
  return clampSettleAt(chore, nowMs, proposedMs);
}
