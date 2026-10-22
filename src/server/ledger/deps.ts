import type { RulesConfig } from "../../domain/rules/index.js";
import type { Db } from "../db.js";
import type { Flags } from "../flags.js";
import type { JobRunner } from "../gemma/runner.js";
import type { WeatherClient } from "../weather/client.js";

/**
 * Work that continues after the HTTP response (the bookmaker job of a new card). Errors go to
 * `onError`; `idle()` lets tests and a clean shutdown wait for all of it.
 */
export class BackgroundTasks {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly onError: (error: unknown) => void) {}

  track(task: Promise<void>): void {
    const tracked: Promise<void> = task
      .catch((error: unknown) => {
        this.onError(error);
      })
      .finally(() => {
        this.running.delete(tracked);
      });
    this.running.add(tracked);
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }
}

/** Everything the ledger needs; tests pass fakes and a fake clock. */
export interface LedgerDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly weather: WeatherClient;
  /** Runs the Gemma jobs: queue, deadline, retry, decision log. */
  readonly gemma: JobRunner;
  readonly rules: RulesConfig;
  readonly flags: Flags;
  readonly background: BackgroundTasks;
}
