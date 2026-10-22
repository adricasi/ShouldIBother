/**
 * The fake model of the backtest (`--fake-model`, CI): recorded fixtures, no GPU, no network.
 * The scenario follows the rule band shown in the prompt, so the pipeline sees a spread of bands:
 * the "E2B" fake is one band more optimistic than the rule, the others echo it.
 */

import { BAND_NAMES } from "../../server/gemma/bookmaker.js";
import { FakeModelClient, type ScenarioSelector } from "../../server/model/fake.js";

import type { StrategyId } from "./types.js";

const RULE_BAND = /"rule_band":"([a-z_]+)"/;

export function backtestScenario(shift: number): ScenarioSelector {
  return (request) => {
    const text = request.messages.map((message) => message.content).join("\n");
    const name = RULE_BAND.exec(text)?.[1];
    const index = BAND_NAMES.findIndex((band) => band === name);
    const band =
      BAND_NAMES[Math.min(BAND_NAMES.length - 1, Math.max(0, (index < 0 ? 2 : index) + shift))];
    return `backtest-${(band ?? "toss_up").replaceAll("_", "-")}`;
  };
}

export function backtestFakeModel(id: StrategyId): FakeModelClient {
  return new FakeModelClient({ scenario: backtestScenario(id === "e2b" ? 1 : 0) });
}
