import type { Band } from "../../domain/bands.js";
import type { ChoreType } from "../../domain/chores.js";
import { plantsRuleQuote, type RuleQuote, type RulesConfig } from "../../domain/rules/index.js";
import { madridWallTime } from "../../domain/time.js";
import type { ForecastHour } from "../../domain/weather.js";

/**
 * Per-chore rule baseline and settle bounds, behind two small seams. Both tables are keyed by
 * `ChoreType`, so when T-005 adds chore types the compiler points here: replace them with
 * `ruleQuote(chore, ...)` and `clampSettleAt(chore, ...)` from the domain.
 */
const RULE_QUOTES: Readonly<
  Record<
    ChoreType,
    (
      forecast: readonly ForecastHour[],
      fromMs: number,
      toMs: number,
      config: RulesConfig,
    ) => RuleQuote | null
  >
> = {
  plants: plantsRuleQuote,
};

/** The rule baseline of a chore over `[fromMs, toMs)`; null when the forecast does not cover it. */
export function ruleQuoteFor(
  chore: ChoreType,
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
): RuleQuote | null {
  return RULE_QUOTES[chore](forecast, fromMs, toMs, config);
}

export interface SettleBounds {
  readonly earliestMs: number;
  readonly latestMs: number;
}

/** Design.md, Settle-time bounds (Europe/Madrid). */
const SETTLE_BOUNDS: Readonly<Record<ChoreType, (nowMs: number) => SettleBounds>> = {
  // Plants: the next day, 08:00 to 12:00.
  plants: (nowMs) => ({
    earliestMs: madridWallTime(nowMs, 1, 8),
    latestMs: madridWallTime(nowMs, 1, 12),
  }),
};

export function settleBoundsOf(chore: ChoreType, nowMs: number): SettleBounds {
  return SETTLE_BOUNDS[chore](nowMs);
}

/** Gemma proposes `settle_in_hours`; code clamps the settle time into the chore's bounds. */
export function clampSettle(chore: ChoreType, nowMs: number, proposedMs: number): number {
  const { earliestMs, latestMs } = settleBoundsOf(chore, nowMs);
  return Math.min(Math.max(proposedMs, earliestMs), latestMs);
}

/** The band of the rule baseline, or `fallback` when the forecast does not cover the window. */
export function ruleBandOrFallback(
  chore: ChoreType,
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
  fallback: Band,
): Band {
  return ruleQuoteFor(chore, forecast, fromMs, toMs, config)?.band ?? fallback;
}
