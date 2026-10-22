import { markDueBets } from "./ledger/bets.js";
import { retryAwaitingWeather } from "./ledger/recorded-weather.js";
import type { LedgerDeps } from "./ledger/deps.js";

/** Design: the scheduler loop runs every 60 s. */
export const SCHEDULER_INTERVAL_MS = 60_000;

export interface Scheduler {
  /** One pass: mark due bets. Exposed so tests drive it with a fake clock. */
  tick(): number;
  /** The weather step: bets waiting for recorded weather ask again every 30 min (AC-014.5). */
  tickWeather(): Promise<number>;
  /**
   * The settlement step: stores the recorded weather of due bets, judges do-it decisions, answered
   * bets that wait for Gemma and unanswered bets 24 h after their settle time (AC-008.7–AC-008.9).
   */
  tickSettlement(): Promise<number>;
  start(): void;
  stop(): void;
}

/**
 * The 60 s loop. All state is in SQLite, so after a restart the first tick picks up every open
 * bet whose settle time passed while the server was down (NFR-003). Later tasks add weather
 * retries, auto-settle and rescue checks here.
 */
export function createScheduler(
  deps: Pick<LedgerDeps, "db" | "now"> & Partial<Pick<LedgerDeps, "weather">>,
  onError: (error: unknown) => void,
  steps: { readonly settle?: () => Promise<number> } = {},
): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let weatherStep: Promise<number> | undefined;
  let settleStep: Promise<number> | undefined;
  const tick = (): number => markDueBets(deps.db, deps.now());
  const tickWeather = (): Promise<number> => {
    const { weather } = deps;
    if (weather === undefined) {
      return Promise.resolve(0);
    }
    // One weather pass at a time: a slow Open-Meteo must not stack up passes.
    weatherStep ??= retryAwaitingWeather({ db: deps.db, now: deps.now, weather }).finally(() => {
      weatherStep = undefined;
    });
    return weatherStep;
  };
  const tickSettlement = (): Promise<number> => {
    const { settle } = steps;
    if (settle === undefined) {
      return Promise.resolve(0);
    }
    // One pass at a time: a slow Gemma must not stack up passes.
    settleStep ??= settle().finally(() => {
      settleStep = undefined;
    });
    return settleStep;
  };
  return {
    tick,
    tickWeather,
    tickSettlement,
    start() {
      if (timer !== undefined) {
        return;
      }
      const safeTick = (): void => {
        try {
          tick();
        } catch (error) {
          onError(error);
        }
        tickWeather().catch(onError);
        tickSettlement().catch(onError);
      };
      safeTick();
      timer = setInterval(safeTick, SCHEDULER_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
