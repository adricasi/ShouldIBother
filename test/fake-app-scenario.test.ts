import { describe, expect, it } from "vitest";

import { untrustedBlock } from "../src/server/gemma/untrusted.js";
import {
  appScenario,
  bookmakerScenarioFromData,
  listenerScenarioFromText,
} from "../src/server/fakes.js";
import type { ChatRequest } from "../src/server/model/client.js";

function listenerCall(text: string): ChatRequest {
  return {
    job: "listener",
    messages: [
      // The prompt names chore types too: only the typed text may pick the fixture.
      { role: "system", content: "Chore types: car_rinse, windows_clean, outdoor_paint." },
      { role: "user", content: untrustedBlock({ text }) },
    ],
  } as unknown as ChatRequest;
}

describe("the app's fake listener reads the typed words (sib demo, npm run dev)", () => {
  it.each([
    ["clean the windows", "advice-windows"],
    ["paint the fence outside", "advice-paint"],
    ["varnish the bench", "advice-paint"],
    ["sweep the balcony leaves", "advice-sweep"],
    ["feed the lawn", "advice-lawn"],
    ["rinse the car", "car-rinse"],
    ["hose the terrace and fill the rain barrel", "rain-chores"],
    ["hang the laundry", "laundry-line"],
    ["water the plants", "ok"],
    ["pay the electricity bill", "ok"],
  ])("%s → %s", (text, scenario) => {
    expect(listenerScenarioFromText(listenerCall(text))).toBe(scenario);
  });

  it("ignores chore names in the prompt and keeps the judge's selection for other jobs", () => {
    expect(listenerScenarioFromText(listenerCall("water the plants"))).toBe("ok");
    const judge = { job: "judge", messages: [{ role: "user", content: "rinse the car" }] };
    expect(appScenario(judge as unknown as ChatRequest)).toBe("ok");
  });
});

function bookmakerCall(choreType: string, ruleBand: string): ChatRequest {
  return {
    job: "bookmaker",
    messages: [
      { role: "system", content: "Rule bands: likely, very_likely." },
      { role: "user", content: untrustedBlock({ chore_type: choreType, rule_band: ruleBand }) },
    ],
  } as unknown as ChatRequest;
}

describe("the app's fake bookmaker prices a city rain bet within one band of the rule", () => {
  it.each([
    ["car_rinse", "very_unlikely", "rain-dry"],
    ["rain_fill", "toss_up", "rain-dry"],
    ["terrace_rinse", "likely", "rain-likely"],
    ["bike_rinse", "very_likely", "rain-likely"],
    ["plants", "very_likely", "ok"],
  ])("%s with a %s rule → %s", (choreType, ruleBand, scenario) => {
    expect(bookmakerScenarioFromData(bookmakerCall(choreType, ruleBand))).toBe(scenario);
    expect(appScenario(bookmakerCall(choreType, ruleBand))).toBe(scenario);
  });
});
