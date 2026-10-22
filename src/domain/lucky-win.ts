import type { ChoreType } from "./chores.js";
import {
  IncompleteWeatherError,
  isLuckyWin,
  outcomeLabel,
  outcomeWindow,
  type HourlyWeather,
  type TimeWindow,
} from "./outcomes.js";
import { madridDateOf } from "./time.js";

interface BetTimes {
  readonly placedAt: number;
  readonly settleAt: number;
}

/**
 * The window the outcome label is applied to for a live bet (design.md, Outcome labels): the
 * chore's full fixed window on the day the bet was placed (line-dry 10:00 to 18:00, plants 19:00 to
 * 10:00 next day). The hours before the bet was placed have been recorded too, so the window is
 * not cut at the start. It is cut at the end only where the hours are not there yet: at `nowMs`.
 * Laundry tonight starts at sunset, which a bet does not store; the moment it was placed stands in
 * for it (T-013 owns that chore's settlement).
 */
export function labelWindowOf(chore: ChoreType, bet: BetTimes, nowMs: number): TimeWindow {
  const fixed = outcomeWindow(chore, madridDateOf(bet.placedAt), bet.placedAt);
  return { startMs: fixed.startMs, endMs: Math.min(fixed.endMs, nowMs) };
}

/**
 * The fallback when the hours before the bet cannot be fetched: the fixed window cut to the time
 * the bet was open, which is all the settle snapshot covers. When the two do not overlap (an AC
 * night placed after midnight) the bet's own window is used.
 */
export function cutWindowOf(chore: ChoreType, bet: BetTimes): TimeWindow {
  const own: TimeWindow = { startMs: bet.placedAt, endMs: bet.settleAt };
  const fixed = outcomeWindow(chore, madridDateOf(bet.placedAt), bet.placedAt);
  const clipped: TimeWindow = {
    startMs: Math.max(fixed.startMs, own.startMs),
    endMs: Math.min(fixed.endMs, own.endMs),
  };
  return clipped.startMs < clipped.endMs ? clipped : own;
}

/**
 * AC-008.6: a do-nothing win is a lucky win when the recorded weather does not meet the chore's
 * outcome label. Computed here, by code, never by Gemma. Null when the recorded hours lack what
 * the label needs: the win still pays, and the lucky-win share leaves it out.
 */
export function luckyWinOf(
  chore: ChoreType,
  window: TimeWindow,
  hours: readonly HourlyWeather[],
): boolean | null {
  try {
    return isLuckyWin(outcomeLabel(chore, hours, window));
  } catch (error) {
    if (error instanceof IncompleteWeatherError) {
      return null;
    }
    throw error;
  }
}
