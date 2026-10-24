import type { ChoreType } from "./chores.js";
import {
  IncompleteWeatherError,
  isLuckyWin,
  isRainChore,
  rainWindow,
  outcomeLabel,
  outcomeWindow,
  type HourlyWeather,
  type TimeWindow,
} from "./outcomes.js";
import { madridDateOf } from "./time.js";

interface BetTimes {
  /** When the bet's card was made (`cards.created_at`); the city rain windows start there. */
  readonly createdAt?: number;
  readonly placedAt: number;
  readonly settleAt: number;
  /**
   * The sunset the bet's card was priced on (laundry tonight only, `cards.sunset_at`): the label
   * window starts there, not when the bet was placed (design.md, Outcome labels).
   */
  readonly sunsetAt?: number | null;
}

/** A laundry-tonight bet whose card stored no sunset: its label window cannot be known. */
export class MissingSunsetError extends Error {
  override readonly name = "MissingSunsetError";
}

/** The chore's full fixed window for the day of the bet (laundry tonight: from its stored sunset). */
function fixedWindowOf(chore: ChoreType, bet: BetTimes): TimeWindow {
  if (isRainChore(chore)) {
    // A rain bet's label is the rain over the window its rule looked at, from its card's creation
    // (design.md, City rain bets); the card is made at or before the bet is placed.
    return rainWindow(chore, bet.createdAt ?? bet.placedAt);
  }
  if (chore === "laundry_tonight") {
    if (bet.sunsetAt === undefined || bet.sunsetAt === null) {
      throw new MissingSunsetError("laundry tonight needs the sunset stored on its card");
    }
    return outcomeWindow(chore, madridDateOf(bet.sunsetAt), bet.sunsetAt);
  }
  return outcomeWindow(chore, madridDateOf(bet.placedAt));
}

/**
 * The window the outcome label is applied to for a live bet (design.md, Outcome labels): the
 * chore's full fixed window on the day the bet was placed (line-dry 10:00 to 18:00, plants 19:00 to
 * 10:00 next day). The hours before the bet was placed have been recorded too, so the window is
 * not cut at the start. It is cut at the end only where the hours are not there yet: at `nowMs`.
 * Laundry tonight starts at the sunset stored on its card (`bet.sunsetAt`); without one it throws
 * `MissingSunsetError`, and the caller leaves the win's lucky flag unknown.
 */
export function labelWindowOf(chore: ChoreType, bet: BetTimes, nowMs: number): TimeWindow {
  const fixed = fixedWindowOf(chore, bet);
  return { startMs: fixed.startMs, endMs: Math.min(fixed.endMs, nowMs) };
}

/**
 * The fallback when the hours before the bet cannot be fetched: the fixed window cut to the time
 * the bet was open, which is all the settle snapshot covers. When the two do not overlap (an AC
 * night placed after midnight) the bet's own window is used.
 */
export function cutWindowOf(chore: ChoreType, bet: BetTimes): TimeWindow {
  const own: TimeWindow = { startMs: bet.placedAt, endMs: bet.settleAt };
  const fixed = fixedWindowOf(chore, bet);
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
