import type { RulesConfig } from "../../domain/rules/index.js";
import type { Db } from "../db.js";
import type { ModelClient } from "../model/client.js";
import type { WeatherClient } from "../weather/client.js";

/** Everything the ledger needs; tests pass fakes and a fake clock. */
export interface LedgerDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly weather: WeatherClient;
  readonly model: ModelClient;
  readonly rules: RulesConfig;
}
