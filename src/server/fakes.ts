import { CHORES, LAUNDRY_PLAN_SPEC } from "../domain/chores.js";

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
  car_clean: "rain-win",
  car_dirty: "rain-dirty-loss",
  car_dirtier: "rain-dirtier-loss",
  bike_clean: "rain-win",
  bike_dirty: "rain-dirty-loss",
  bike_dirtier: "rain-dirtier-loss",
  terrace_rinsed: "rain-win",
  terrace_dirty: "rain-dirty-loss",
  fill_full: "rain-win",
  fill_low: "rain-dirty-loss",
  plan_dry: "ok",
  plan_damp: "small-loss",
  plan_wet: "normal-loss",
};

/**
 * The planner's day_0 has no drying hours once the afternoon window has closed (after 18:00
 * Madrid), and the planner's check then needs it scored "very_unlikely". The data block says so
 * with `"drying_window":null` in the day_0 entry.
 */
const DAY_0_CLOSED = /"key":"day_0"[^{}]*"drying_window":null/;

export const judgeScenarioFromAnswer: ScenarioSelector = (request) => {
  if (request.job === "laundry-planner") {
    const text = request.messages.map((message) => message.content).join("\n");
    return DAY_0_CLOSED.test(text) ? "ok-day0-closed" : "ok";
  }
  if (request.job !== "judge") {
    return "ok";
  }
  const text = request.messages.map((message) => message.content).join("\n");
  if (text.includes('"appeal":{')) {
    // An appeal brings a new photo; the fake judge reads it as proof the plants are fine.
    return "appeal-win";
  }
  if (text.includes('"bet":"do_it"')) {
    // A do-it decision is scored on the recorded weather: wet hours mean the weather had it.
    return /"wet_hours":[1-9]/.test(text) ? "do-it-would-have" : "do-it-would-not";
  }
  // The answer is in the data block, not in the prompt, which quotes some labels (REQ-030).
  const data = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n");
  for (const chore of [...Object.values(CHORES), LAUNDRY_PLAN_SPEC]) {
    for (const answer of chore.tapAnswers) {
      if (data.includes(answer.label)) {
        return JUDGE_SCENARIO_BY_ANSWER[answer.id] ?? "ok";
      }
    }
  }
  // An after photo of a city rain bet (no tap to read): the rain did its job.
  return data.includes('"chore":"let the rain') ? "rain-win" : "ok";
};

/**
 * The listener fixture for a typed sentence, so `sib demo` and `npm run dev` turn "clean the
 * windows" or "rinse the car" into those cards instead of the default plants card. First match
 * wins; a sentence with no match keeps the `ok` fixture. Only the typed text is read.
 */
const LISTENER_SCENARIO_BY_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\bwindows?\b/i, "advice-windows"],
  [/\b(paint|varnish)/i, "advice-paint"],
  [/\b(sweep|leaves)\b/i, "advice-sweep"],
  [/\b(lawn|grass|fertili[sz]e)/i, "advice-lawn"],
  [/\bcar\b/i, "car-rinse"],
  [/\b(bike|bicycle|terrace|barrel|bird ?bath|pond)\b/i, "rain-chores"],
  [/\b(laundry|washing|hang)/i, "laundry-line"],
];

export const listenerScenarioFromText: ScenarioSelector = (request) => {
  const typed = request.messages
    .filter((message) => message.role !== "system")
    .map(
      (message) =>
        /<untrusted_data>\n([\s\S]*)\n<\/untrusted_data>/.exec(message.content)?.[1] ?? "",
    )
    .join("\n");
  return LISTENER_SCENARIO_BY_WORDS.find(([words]) => words.test(typed))?.[1] ?? "ok";
};

/**
 * The bookmaker fixture for a city rain bet in the app, kept within one band of the rule so the
 * fake answer is valid (a 2-band gap needs a reason): a wet rule gets "likely", any other "unlikely".
 */
const RAIN_CHORE_IN_DATA = /"chore_type":"(car_rinse|bike_rinse|terrace_rinse|rain_fill)"/;
const WET_RULE_IN_DATA = /"rule_band":"(likely|very_likely)"/;

export const bookmakerScenarioFromData: ScenarioSelector = (request) => {
  const data = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n");
  if (!RAIN_CHORE_IN_DATA.test(data)) {
    return "ok";
  }
  return WET_RULE_IN_DATA.test(data) ? "rain-likely" : "rain-dry";
};

/**
 * The app's fake model: the listener reads the typed words and the bookmaker prices city rain
 * bets; every other job as in the tests.
 */
export const appScenario: ScenarioSelector = (request) => {
  if (request.job === "listener") {
    return listenerScenarioFromText(request);
  }
  if (request.job === "bookmaker") {
    return bookmakerScenarioFromData(request);
  }
  return judgeScenarioFromAnswer(request);
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
    model: new FakeModelClient({ scenario: appScenario }),
    weather: new FakeWeatherClient(now),
  };
}
