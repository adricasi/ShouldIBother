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

/**
 * The window the outcome label is applied to for a live bet: the chore's fixed window on the day
 * the bet was placed (design.md, Outcome labels), cut to the time the bet was actually open. The
 * recorded weather only covers `[placedAt, settleAt)`, so a bet placed at 22:00 cannot be judged
 * on a plants window that starts at 19:00. When the two do not overlap (an AC night placed after
 * midnight) the bet's own window is used. Laundry tonight starts at sunset, which a bet does not
 * store; the moment it was placed stands in for it.
 */
export function labelWindowOf(
  chore: ChoreType,
  bet: { readonly placedAt: number; readonly settleAt: number },
): TimeWindow {
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
  bet: { readonly placedAt: number; readonly settleAt: number },
  hours: readonly HourlyWeather[],
): boolean | null {
  try {
    return isLuckyWin(outcomeLabel(chore, hours, labelWindowOf(chore, bet)));
  } catch (error) {
    if (error instanceof IncompleteWeatherError) {
      return null;
    }
    throw error;
  }
}
