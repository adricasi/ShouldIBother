import { markDueBets } from "./ledger/bets.js";
import type { LedgerDeps } from "./ledger/deps.js";

/** Design: the scheduler loop runs every 60 s. */
export const SCHEDULER_INTERVAL_MS = 60_000;

export interface Scheduler {
  /** One pass: mark due bets. Exposed so tests drive it with a fake clock. */
  tick(): number;
  start(): void;
  stop(): void;
}

/**
 * The 60 s loop. All state is in SQLite, so after a restart the first tick picks up every open
 * bet whose settle time passed while the server was down (NFR-003). Later tasks add weather
 * retries, auto-settle and rescue checks here.
 */
export function createScheduler(
  deps: Pick<LedgerDeps, "db" | "now">,
  onError: (error: unknown) => void,
): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  const tick = (): number => markDueBets(deps.db, deps.now());
  return {
    tick,
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
