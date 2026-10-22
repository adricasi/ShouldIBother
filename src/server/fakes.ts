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
};

export const judgeScenarioFromAnswer: ScenarioSelector = (request) => {
  if (request.job !== "judge") {
    return "ok";
  }
  const text = request.messages.map((message) => message.content).join("\n");
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
 * The services of the walking skeleton: the real Ollama and Open-Meteo clients arrive with T-010
 * and T-005, so until then `sib start` runs on the same fakes as CI.
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
