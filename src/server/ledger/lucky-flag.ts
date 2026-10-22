import { LAUNDRY_PLAN, type ChoreType } from "../../domain/chores.js";
import { planBetWindow } from "../../domain/laundry-plan.js";
import {
  MissingSunsetError,
  cutWindowOf,
  labelWindowOf,
  luckyWinOf,
} from "../../domain/lucky-win.js";
import type { WeatherSnapshot } from "../../domain/weather-digest.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { cardLocationOf } from "./card-location.js";
import type { LedgerDeps } from "./deps.js";
import type { BetRow, CardRow } from "./rows.js";

/**
 * The lucky flag of a won bet (AC-008.6): the chore's outcome label on its full fixed window,
 * with the hours before the bet was placed read from the recorded weather too. Where those
 * cannot be fetched, the label is applied to the window the settle snapshot covers. Laundry
 * tonight's window starts at the sunset stored on its card; without one the flag is unknown.
 * Shared by the first settlement and by an appeal (REQ-023), which can turn a loss into a win.
 */
export async function luckyFlagFor(
  deps: Pick<LedgerDeps, "weather" | "now" | "log">,
  choreType: ChoreType,
  bet: BetRow,
  card: CardRow,
  snapshot: WeatherSnapshot,
): Promise<boolean | null> {
  if (card.chore_type === LAUNDRY_PLAN) {
    // The snapshot is the recorded drying hours of the chosen day: exactly the label's window.
    const { fromMs, toMs } = planBetWindow(bet.settle_at);
    return luckyWinOf(choreType, { startMs: fromMs, endMs: toMs }, snapshot.hours);
  }
  const times = {
    placedAt: bet.placed_at,
    settleAt: bet.settle_at,
    sunsetAt: card.sunset_at,
  };
  let window;
  try {
    window = labelWindowOf(choreType, times, deps.now());
  } catch (error) {
    if (error instanceof MissingSunsetError) {
      return null;
    }
    throw error;
  }
  if (window.endMs > window.startMs) {
    try {
      const recorded = await deps.weather.getRecorded({
        fromMs: window.startMs,
        toMs: window.endMs,
        ...cardLocationOf(card),
      });
      if (recorded.complete) {
        return luckyWinOf(choreType, window, recorded.hours);
      }
    } catch (error) {
      if (!(error instanceof WeatherUnavailableError)) {
        throw error;
      }
    }
  }
  // The hours before the bet was placed could not be fetched: the label uses the hours the bet
  // was open, which can differ from the full window. Logged with the bet id only.
  deps.log({ event: "lucky_win_cut_window", bet_id: bet.id });
  return luckyWinOf(choreType, cutWindowOf(choreType, times), snapshot.hours);
}
