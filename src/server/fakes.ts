import { CHORES } from "../domain/chores.js";

import { FakeModelClient, type ScenarioSelector } from "./model/fake.js";
import { FakeWeatherClient } from "./weather/fake.js";

/**
 * Fixture scenario of the judge for each tap answer, so the fake model "reads" the answer the
 * way a real judge would: fine plants win, a dry pot loses, wilting is the harmful loss.
 */
const JUDGE_SCENARIO_BY_ANSWER: Readonly<Record<string, string>> = {
  moist: "ok",
  dry: "normal-loss",
  wilting: "harmful-loss",
  line_dry: "ok",
  line_damp: "small-loss",
  line_wet: "normal-loss",
  tonight_dry: "ok",
  tonight_damp: "small-loss",
  tonight_wet: "normal-loss",
  ac_fine: "ok",
  ac_warm: "small-loss",
  heater_fine: "ok",
  heater_cold: "small-loss",
};

export const judgeScenarioFromAnswer: ScenarioSelector = (request) => {
  if (request.job !== "judge") {
    return "ok";
  }
  const text = request.messages.map((message) => message.content).join("\n");
  if (text.includes('"bet":"do_it"')) {
    // A do-it decision is scored on the recorded weather: wet hours mean the weather had it.
    return /"wet_hours":[1-9]/.test(text) ? "do-it-would-have" : "do-it-would-not";
  }
  for (const chore of Object.values(CHORES)) {
    for (const answer of chore.tapAnswers) {
      if (text.includes(answer.label)) {
        return JUDGE_SCENARIO_BY_ANSWER[answer.id] ?? "ok";
      }
    }
  }
  return "ok";
};

/**
 * The fake services CI and `npm run dev` use. The fake model is chosen only with
 * `SIB_FAKE_MODEL=1`; the live app uses the Open-Meteo client unless `SIB_FAKE_WEATHER=1` asks for
 * fake weather (no network needed).
 */
export function createFakeServices(now: () => number): {
  model: FakeModelClient;
  weather: FakeWeatherClient;
} {
  return {
    model: new FakeModelClient({ scenario: judgeScenarioFromAnswer }),
    weather: new FakeWeatherClient(now),
  };
}
