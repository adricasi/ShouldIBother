import type { SavingsCatalogue } from "../../domain/savings.js";
import type { RulesConfig } from "../../domain/rules/index.js";
import type { Household } from "../config.js";
import type { Db } from "../db.js";
import type { Flags } from "../flags.js";
import type { JobRunner } from "../gemma/runner.js";
import type { PhotoStore } from "../photos/store.js";
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
  /** The household baseline: whether the AC and heater are used this season (AC-016.5). */
  readonly household: Household;
  readonly flags: Flags;
  /** What one won bet saves per chore; the figure is written on the bet when it is placed (REQ-011). */
  readonly savings: SavingsCatalogue;
  /** The photo files in the data folder (REQ-005, REQ-015). */
  readonly photos: PhotoStore;
  readonly background: BackgroundTasks;
  /** Structured log line for a notable event (ids and numbers only, never household text). */
  readonly log: (entry: Readonly<Record<string, unknown>>) => void;
}
