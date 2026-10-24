import { RAIN_CHORES } from "../domain/outcomes.js";
import type { RulesConfig } from "../domain/rules/index.js";
import type { SavingsCatalogue } from "../domain/savings.js";

import type { Flags } from "./flags.js";

/**
 * With `rainChores` on, the city rain rows must be there: `config/rules-rain.json` and a savings
 * row for each rain chore in `config/savings.json`. A missing file would otherwise show up on the
 * first rain card as an error. Throws at start-up instead, naming what is missing (REQ-030).
 */
export function assertRainConfig(
  flags: Pick<Flags, "rainChores">,
  rules: Pick<RulesConfig, "rain">,
  savings: Pick<SavingsCatalogue, "rain">,
): void {
  if (!flags.rainChores) {
    return;
  }
  if (rules.rain === undefined) {
    throw new Error("The flag rainChores is on but config/rules-rain.json is missing");
  }
  const missing = RAIN_CHORES.filter((chore) => savings.rain?.[chore] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `The flag rainChores is on but config/savings.json has no rain row for ${missing.join(", ")}`,
    );
  }
}
