import { describe, expect, it } from "vitest";

import { oddsOfBand, type Band } from "../src/domain/bands.js";
import { CHORES } from "../src/domain/chores.js";
import {
  bandTable,
  parseRulesConfig,
  plantsBand,
  plantsRuleQuote,
} from "../src/domain/rules/index.js";
import { plantsFacts, type PlantsFacts } from "../src/domain/rules/plants.js";
import { madridParts, madridWallTime } from "../src/domain/time.js";
import { HOUR_MS, type ForecastHour } from "../src/domain/weather.js";
import { loadRules } from "../src/server/rules.js";
import { fakeForecastHours, FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

const rules = loadRules();

function facts(overrides: Partial<PlantsFacts>): PlantsFacts {
  return { rainMm: 0, maxHourlyProbabilityPct: 0, maxTempC: 30, hours: 24, ...overrides };
}

describe("REQ-004: plants rule band (design.md, first match wins, half-open intervals)", () => {
  it.each<[string, Partial<PlantsFacts>, Band]>([
    ["rain 5 mm is the lower bound of very likely", { rainMm: 5 }, 4],
    ["rain just under 5 mm is likely", { rainMm: 4.9 }, 3],
    ["rain 2 mm is the lower bound of likely", { rainMm: 2 }, 3],
    ["rain just under 2 mm is a toss-up", { rainMm: 1.9 }, 2],
    ["rain 0.5 mm is the lower bound of toss-up", { rainMm: 0.5 }, 2],
    ["rain just under 0.5 mm and hot is very unlikely", { rainMm: 0.4, maxTempC: 30 }, 0],
    [
      "60% in one hour is a toss-up even without rain",
      { maxHourlyProbabilityPct: 60, maxTempC: 30 },
      2,
    ],
    ["59% in one hour and hot is very unlikely", { maxHourlyProbabilityPct: 59, maxTempC: 30 }, 0],
    ["max temperature just under 26 is unlikely", { maxTempC: 25.9 }, 1],
    ["max temperature 26 is very unlikely", { maxTempC: 26 }, 0],
    ["the first matching row wins over later rows", { rainMm: 5, maxTempC: 10 }, 4],
    ["rain beats a cool day", { rainMm: 2, maxTempC: 10 }, 3],
  ])("%s", (_name, overrides, band) => {
    expect(plantsBand(facts(overrides), rules)).toBe(band);
  });

  it("maps bands to the fixed odds 15, 35, 50, 70, 85", () => {
    const table = bandTable(rules);
    expect(([0, 1, 2, 3, 4] as const).map((band) => oddsOfBand(table, band))).toEqual([
      15, 35, 50, 70, 85,
    ]);
  });

  it("sums hourly rain without float drift (fifty 0.1 mm hours are exactly 5 mm)", () => {
    const hours: ForecastHour[] = fakeForecastHours(
      { temperatureC: 30, rain: { startsAfterHours: 0, hours: 50, mmPerHour: 0.1 } },
      0,
      50,
    );
    const seen = plantsFacts(hours, 0, 50 * HOUR_MS);
    expect(seen?.rainMm).toBe(5);
    expect(plantsBand(seen!, rules)).toBe(4);
  });

  it("looks only at hours inside the window: now to the settle time", () => {
    const hours = fakeForecastHours(
      { temperatureC: 30, rain: { startsAfterHours: 10, hours: 2, mmPerHour: 4 } },
      0,
      24,
    );
    expect(plantsFacts(hours, 0, 10 * HOUR_MS)?.rainMm).toBe(0);
    expect(plantsFacts(hours, 0, 11 * HOUR_MS)?.rainMm).toBe(4);
    // An hour that ended before `now` does not count; one that is under way does.
    expect(plantsFacts(hours, 12 * HOUR_MS, 24 * HOUR_MS)?.rainMm).toBe(0);
    expect(plantsFacts(hours, 11.5 * HOUR_MS, 24 * HOUR_MS)?.rainMm).toBe(4);
  });

  it("has no band unless the forecast covers the whole window (no false odds from a part)", () => {
    const hours = fakeForecastHours({ temperatureC: 30 }, 0, 24); // covers [0 h, 24 h)
    expect(plantsFacts(hours, 0, 24 * HOUR_MS)).not.toBeNull();
    // Ends too early: the window runs to 30 h.
    expect(plantsFacts(hours, 0, 30 * HOUR_MS)).toBeNull();
    expect(plantsRuleQuote(hours, 0, 30 * HOUR_MS, rules)).toBeNull();
    // Starts too late: the forecast begins after `from`.
    expect(plantsFacts(hours.slice(3), 0, 24 * HOUR_MS)).toBeNull();
    // A hole in the middle (hour 10 missing).
    const holed = hours.filter((_hour, index) => index !== 10);
    expect(plantsFacts(holed, 0, 24 * HOUR_MS)).toBeNull();
    // `from` inside the first hour is covered by it.
    expect(plantsFacts(hours, 0.5 * HOUR_MS, 24 * HOUR_MS)).not.toBeNull();
  });

  it("has no band when the forecast does not cover the window", () => {
    expect(plantsFacts([], 0, HOUR_MS)).toBeNull();
    expect(plantsRuleQuote([], 0, HOUR_MS, rules)).toBeNull();
  });

  it("gives a plain reason with the band name and odds", () => {
    const hours = fakeForecastHours(FAKE_WEATHER_PROFILES.rainy, 0, 48);
    const quote = plantsRuleQuote(hours, 0, 24 * HOUR_MS, rules);
    expect(quote?.band).toBe(3);
    expect(quote?.reason).toContain("3 mm of rain");
    expect(quote?.reason).toContain("likely (70%)");
  });

  it("refuses a rules file with an unknown key in the plants rows", () => {
    const raw = JSON.parse(JSON.stringify(rules)) as { chores: { plants: { rows: object[] } } };
    raw.chores.plants.rows.push({ snowCm: 1, band: 0 });
    expect(() => parseRulesConfig(raw)).toThrow("Invalid rules config");
  });
});

describe("settle time for plants: next day 08:00 in Madrid", () => {
  const settle = CHORES.plants.ruleSettleAt;

  it("is 08:00 Madrid the next day (CEST, UTC+2)", () => {
    const now = Date.UTC(2026, 9, 22, 8, 0); // 22 Oct 10:00 Madrid
    expect(settle(now)).toBe(Date.UTC(2026, 9, 23, 6, 0));
  });

  it("follows the clock change on 25 Oct 2026 (UTC+2 to UTC+1)", () => {
    const saturday = Date.UTC(2026, 9, 24, 18, 0);
    expect(settle(saturday)).toBe(Date.UTC(2026, 9, 25, 7, 0));
    expect(madridParts(settle(saturday))).toMatchObject({ day: 25, hour: 8, minute: 0 });
  });

  it("uses the Madrid date, not the UTC date, just after midnight in Madrid", () => {
    const now = Date.UTC(2026, 9, 22, 22, 30); // 23 Oct 00:30 Madrid
    expect(settle(now)).toBe(Date.UTC(2026, 9, 24, 6, 0));
  });

  it("finds wall times in March too (UTC+1 to UTC+2 on 29 Mar 2026)", () => {
    expect(madridWallTime(Date.UTC(2026, 2, 28, 12, 0), 1, 8)).toBe(Date.UTC(2026, 2, 29, 6, 0));
  });
});
