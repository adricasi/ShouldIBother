/**
 * The strategies that play the simulated days: the rule baseline, the fixed routine and, in
 * `gemma-strategy.ts`, Gemma through `ModelClient`. All decide from a `DecisionInput` only.
 */

import { fixedRoutineAction, actionForBand } from "./policy.js";
import type { Strategy, StrategyDecision, DecisionInput } from "./types.js";

/**
 * The rule baseline: its band for the chore's window, unless the fixed heat/frost/storm backstop
 * fires, which makes the day a "Do it now" alert with no odds (AC-012.1).
 */
export class RuleStrategy implements Strategy {
  readonly id = "rule" as const;
  readonly kind = "rule" as const;

  decide(input: DecisionInput): Promise<StrategyDecision> {
    if (input.alert !== null) {
      return Promise.resolve({ action: "do_it", basis: "safety_alert", band: null });
    }
    return Promise.resolve({
      action: actionForBand(input.ruleBand),
      basis: "rule",
      band: input.ruleBand,
    });
  }
}

/**
 * The habit baseline (water every other day, tumble dry every load, AC on every warm evening):
 * it never reads a forecast and has no odds, so its calibration is n/a (AC-018.3).
 */
export class FixedRoutineStrategy implements Strategy {
  readonly id = "fixed" as const;
  readonly kind = "fixed" as const;

  decide(input: DecisionInput): Promise<StrategyDecision> {
    return Promise.resolve({
      action: fixedRoutineAction(input.chore, input.date),
      basis: "fixed_routine",
      band: null,
    });
  }
}
