import { LAUNDRY_PLAN, type ChoreType } from "../../domain/chores.js";
import { isRainChore, rainWindow } from "../../domain/outcomes.js";
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

function fullRainWindowEnd(
  choreType: ChoreType,
  times: { readonly createdAt: number; readonly placedAt: number },
): number {
  return isRainChore(choreType) ? rainWindow(choreType, times.createdAt).endMs : times.placedAt;
}

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
    createdAt: card.created_at,
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
  // A rinse bet can settle at +12 h, before the 24 h label window has closed: rain still to come
  // could make the label true, so a "not delivered" reading of the partial window is unknown, not
  // lucky. A reading that already delivered (so not lucky) stands.
  const unfinished = isRainChore(choreType) && deps.now() < fullRainWindowEnd(choreType, times);
  const unlessUnfinished = (lucky: boolean | null): boolean | null =>
    unfinished && lucky === true ? null : lucky;
  if (window.endMs > window.startMs) {
    try {
      const recorded = await deps.weather.getRecorded({
        fromMs: window.startMs,
        toMs: window.endMs,
        ...cardLocationOf(card),
      });
      if (recorded.complete) {
        return unlessUnfinished(luckyWinOf(choreType, window, recorded.hours));
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
  return unlessUnfinished(luckyWinOf(choreType, cutWindowOf(choreType, times), snapshot.hours));
}
