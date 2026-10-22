import { describe, expect, it } from "vitest";

import type { Band } from "../src/domain/bands.js";
import { DRYING_INDEX_WEIGHTS, WET_HOUR_MM, dryingIndex } from "../src/domain/outcomes.js";
import {
  acBand,
  heaterBand,
  laundryTonightBand,
  laundryTonightFacts,
  lineDryBand,
  lineDryFacts,
  parseRulesConfig,
  ruleQuote,
  safetyAlert,
  type AcFacts,
  type HeaterFacts,
  type LaundryTonightFacts,
  type LineDryFacts,
} from "../src/domain/rules/index.js";
import { HOUR_MS, type ForecastHour } from "../src/domain/weather.js";
import { readJsonFile } from "../src/server/config.js";
import { loadRules } from "../src/server/rules.js";
import { CONFIG_DIR } from "../src/server/config.js";

const rules = loadRules();

/** One forecast hour starting at `index` hours after hour 0, dry, windy 10, humid 50, no sun. */
function hour(index: number, overrides: Partial<ForecastHour> = {}): ForecastHour {
  return {
    startsAt: index * HOUR_MS,
    precipitationMm: 0,
    precipitationProbabilityPct: 0,
    temperatureC: 20,
    dewPointC: 10,
    relativeHumidityPct: 50,
    windKmh: 10,
    gustKmh: 20,
    sunshineSeconds: 0,
    weatherCode: 1,
    isDay: true,
    ...overrides,
  };
}

const hours = (count: number, overrides: Partial<ForecastHour> = {}): ForecastHour[] =>
  Array.from({ length: count }, (_unused, index) => hour(index, overrides));

describe("REQ-016: line-dry today rule (design.md, first match wins, half-open intervals)", () => {
  const facts = (overrides: Partial<LineDryFacts>): LineDryFacts => ({
    wetHours: 0,
    meanDryingIndex: 0,
    daylightHours: 8,
    maxTempC: 20,
    ...overrides,
  });

  it.each<[string, Partial<LineDryFacts>, Band]>([
    ["D 0.60 is the lower bound of very likely", { meanDryingIndex: 0.6 }, 4],
    ["D just under 0.60 is likely", { meanDryingIndex: 0.599999 }, 3],
    ["D 0.45 is the lower bound of likely", { meanDryingIndex: 0.45 }, 3],
    ["D just under 0.45 is a toss-up", { meanDryingIndex: 0.449999 }, 2],
    ["D 0.30 is the lower bound of toss-up", { meanDryingIndex: 0.3 }, 2],
    ["D just under 0.30 is unlikely", { meanDryingIndex: 0.299999 }, 1],
    ["D 0.15 is the lower bound of unlikely", { meanDryingIndex: 0.15 }, 1],
    ["D just under 0.15 is very unlikely", { meanDryingIndex: 0.149999 }, 0],
    ["D 0 is very unlikely", { meanDryingIndex: 0 }, 0],
    ["any wet hour wins over a perfect D", { wetHours: 1, meanDryingIndex: 1 }, 0],
  ])("%s", (_name, overrides, band) => {
    expect(lineDryBand(facts(overrides), rules)).toBe(band);
  });

  it("a wet hour is 0.2 mm or more: 0.19 is dry, 0.2 is wet", () => {
    const window = (mm: number) =>
      lineDryFacts(hours(8, { precipitationMm: mm }), 0, 8 * HOUR_MS, rules);
    expect(window(0.19)?.wetHours).toBe(0);
    expect(window(WET_HOUR_MM)?.wetHours).toBe(8);
    expect(WET_HOUR_MM).toBe(rules.wetHourMm);
  });

  it("averages D over the daylight hours only", () => {
    const forecast = [
      ...hours(2, { isDay: false, windKmh: 0, relativeHumidityPct: 100 }), // night: D 0
      ...hours(6, { windKmh: 30, relativeHumidityPct: 100, sunshineSeconds: 0 }).map((h, i) => ({
        ...h,
        startsAt: (i + 2) * HOUR_MS,
      })), // day: D = 0.5
    ];
    const seen = lineDryFacts(forecast, 0, 8 * HOUR_MS, rules);
    expect(seen?.daylightHours).toBe(6);
    expect(seen?.meanDryingIndex).toBe(0.5);
  });

  it("a window with no daylight has D 0, never a missing value", () => {
    expect(lineDryFacts(hours(4, { isDay: false }), 0, 4 * HOUR_MS, rules)?.meanDryingIndex).toBe(
      0,
    );
  });

  it("uses the one drying index of the outcome labels, with the weights in rules.json", () => {
    expect(rules.dryingIndex).toEqual(DRYING_INDEX_WEIGHTS);
    expect(rules.wetHourMm).toBe(WET_HOUR_MM);
    const sample = hours(1, { windKmh: 18, relativeHumidityPct: 40, sunshineSeconds: 2700 });
    const expected = dryingIndex({
      precipitationMm: 0,
      windSpeedKmh: 18,
      relativeHumidityPct: 40,
      sunshineSeconds: 2700,
    });
    expect(lineDryFacts(sample, 0, HOUR_MS, rules)?.meanDryingIndex).toBe(expected);
    // 0.5 * 18/30 + 0.3 * 0.6 + 0.2 * 0.75
    expect(expected).toBeCloseTo(0.63, 10);
  });

  it("caps the wind at 30 km/h", () => {
    const calm = hours(1, { windKmh: 30, relativeHumidityPct: 100 });
    const gale = hours(1, { windKmh: 90, relativeHumidityPct: 100 });
    expect(lineDryFacts(gale, 0, HOUR_MS, rules)?.meanDryingIndex).toBe(
      lineDryFacts(calm, 0, HOUR_MS, rules)?.meanDryingIndex,
    );
  });

  it("has no band unless the forecast covers the window", () => {
    expect(ruleQuote("laundry_line", hours(6), 0, 8 * HOUR_MS, rules)).toBeNull();
    expect(ruleQuote("laundry_line", hours(8), 0, 8 * HOUR_MS, rules)).not.toBeNull();
  });
});

describe("REQ-016: leave laundry out tonight rule", () => {
  const facts = (overrides: Partial<LaundryTonightFacts>): LaundryTonightFacts => ({
    wetHours: 0,
    dewHours: 0,
    meanDryingIndex: 0,
    ...overrides,
  });

  it.each<[string, Partial<LaundryTonightFacts>, Band]>([
    ["any wet hour is very unlikely", { wetHours: 1, meanDryingIndex: 1 }, 0],
    ["3 dew hours is unlikely, whatever D", { dewHours: 3, meanDryingIndex: 1 }, 1],
    ["2 dew hours does not count as dew: D decides", { dewHours: 2, meanDryingIndex: 0.5 }, 3],
    ["D 0.45 is the lower bound of likely", { meanDryingIndex: 0.45 }, 3],
    ["D just under 0.45 is a toss-up", { meanDryingIndex: 0.449999 }, 2],
    ["D 0.30 is the lower bound of toss-up", { meanDryingIndex: 0.3 }, 2],
    ["D just under 0.30 falls to unlikely", { meanDryingIndex: 0.299999 }, 1],
  ])("%s", (_name, overrides, band) => {
    expect(laundryTonightBand(facts(overrides), rules)).toBe(band);
  });

  it("temp minus dew point of 2 °C is a dew hour, 2.1 °C is not (upper bound included)", () => {
    const window = (spread: number) =>
      laundryTonightFacts(
        hours(10, { temperatureC: 12, dewPointC: 12 - spread }),
        0,
        10 * HOUR_MS,
        rules,
      );
    expect(window(2)?.dewHours).toBe(10);
    expect(window(2.1)?.dewHours).toBe(0);
  });

  it("counts D over every hour of the night, not only daylight", () => {
    const night = hours(10, { isDay: false, windKmh: 30, relativeHumidityPct: 100 });
    expect(laundryTonightFacts(night, 0, 10 * HOUR_MS, rules)?.meanDryingIndex).toBe(0.5);
  });
});

describe("REQ-016: skip the AC rule", () => {
  const facts = (nightMinC: number, meanWindKmh = 0): AcFacts => ({ nightMinC, meanWindKmh });

  it.each<[string, AcFacts, Band]>([
    ["night min 20.9 is very likely", facts(20.9), 4],
    ["21 is the upper bound: likely", facts(21), 3],
    ["22.9 is likely", facts(22.9), 3],
    ["23 is a toss-up", facts(23), 2],
    ["24.9 is a toss-up", facts(24.9), 2],
    ["25 is unlikely", facts(25), 1],
    ["26.9 is unlikely", facts(26.9), 1],
    ["27 is very unlikely", facts(27), 0],
    ["wind 9.9 km/h lifts nothing", facts(25, 9.9), 1],
    ["wind 10 km/h lifts one band", facts(25, 10), 2],
    ["the lift applies to the lowest band too", facts(30, 10), 1],
    ["the lift stops at very likely", facts(15, 25), 4],
  ])("%s", (_name, seen, band) => {
    expect(acBand(seen, rules)).toBe(band);
  });
});

describe("REQ-016: skip the heater rule", () => {
  const facts = (dayMaxC: number, sunshineHours = 0): HeaterFacts => ({ dayMaxC, sunshineHours });

  it.each<[string, HeaterFacts, Band]>([
    ["20 °C with 5 h of sun is very likely", facts(20, 5), 4],
    ["20 °C with just under 5 h of sun falls to likely", facts(20, 4.99), 3],
    ["just under 20 °C with 5 h of sun is likely", facts(19.9, 5), 3],
    ["18 °C is likely", facts(18), 3],
    ["just under 18 °C is a toss-up", facts(17.9), 2],
    ["15 °C is a toss-up", facts(15), 2],
    ["just under 15 °C is unlikely", facts(14.9), 1],
    ["12 °C is unlikely", facts(12), 1],
    ["just under 12 °C is very unlikely", facts(11.9), 0],
    ["a hot sunny day is still decided by the first matching row", facts(30, 0), 3],
  ])("%s", (_name, seen, band) => {
    expect(heaterBand(seen, rules)).toBe(band);
  });
});

describe("REQ-012: the fixed safety backstop (AC-012.1)", () => {
  const alertFor = (overrides: Partial<ForecastHour>, count = 6) =>
    safetyAlert(hours(count, overrides), 0, count * HOUR_MS, rules);

  it.each([
    ["heat 34.9 °C", { temperatureC: 34.9 }, null],
    ["heat 35 °C (limit included)", { temperatureC: 35 }, "heat"],
    ["frost 2.1 °C", { temperatureC: 2.1 }, null],
    ["frost 2 °C (limit included)", { temperatureC: 2 }, "frost"],
    ["gusts 69.9 km/h", { gustKmh: 69.9 }, null],
    ["gusts 70 km/h (limit included)", { gustKmh: 70 }, "storm"],
    ["weather code 94", { weatherCode: 94 }, null],
    ["weather code 95", { weatherCode: 95 }, "storm"],
    ["weather code 99", { weatherCode: 99 }, "storm"],
    ["weather code 100", { weatherCode: 100 }, null],
  ] as const)("%s", (_name, overrides, kind) => {
    const alert = alertFor(overrides);
    expect(alert?.kinds[0] ?? null).toBe(kind);
  });

  it("looks at every hour of the window and only at its hours", () => {
    const forecast = [...hours(5), hour(5, { temperatureC: 36 }), hour(6, { temperatureC: 36 })];
    expect(safetyAlert(forecast, 0, 5 * HOUR_MS, rules)).toBeNull(); // the hot hours are after it
    expect(safetyAlert(forecast, 0, 6 * HOUR_MS, rules)?.kinds).toEqual(["heat"]);
    expect(safetyAlert(forecast, 5.5 * HOUR_MS, 7 * HOUR_MS, rules)?.kinds).toEqual(["heat"]);
  });

  it("names the reason in words and lists every limit that is crossed", () => {
    const alert = alertFor({ temperatureC: 37, gustKmh: 80 });
    expect(alert?.kinds).toEqual(["storm", "heat"]);
    expect(alert?.reason).toBe(
      "Storm: gusts up to 80 km/h are forecast. Heat: up to 37 °C is forecast.",
    );
    expect(alertFor({ temperatureC: 1 })?.reason).toBe("Frost: down to 1 °C is forecast.");
    expect(alertFor({ weatherCode: 96 })?.reason).toBe("Storm: thunderstorms are forecast.");
  });

  it("does not need the whole window to be covered: a limit in the hours present counts", () => {
    expect(safetyAlert([hour(0, { temperatureC: 40 })], 0, 10 * HOUR_MS, rules)?.kinds).toEqual([
      "heat",
    ]);
    expect(safetyAlert([], 0, HOUR_MS, rules)).toBeNull();
  });
});

describe("the rule quote for every chore", () => {
  it("quotes each chore from a covered window, with a plain reason naming the band and odds", () => {
    const forecast = hours(30, { windKmh: 30, relativeHumidityPct: 30, sunshineSeconds: 3600 });
    const line = ruleQuote("laundry_line", forecast, 0, 8 * HOUR_MS, rules);
    expect(line?.band).toBe(4);
    expect(line?.reason).toContain("very likely (85%) for drying on the line");
    const tonight = ruleQuote(
      "laundry_tonight",
      hours(10, { dewPointC: 0, windKmh: 30 }),
      0,
      10 * HOUR_MS,
      rules,
    );
    expect(tonight?.band).toBe(3);
    const ac = ruleQuote("ac", hours(9, { temperatureC: 19 }), 0, 9 * HOUR_MS, rules);
    expect(ac?.band).toBe(4);
    const heater = ruleQuote(
      "heater",
      hours(14, { temperatureC: 21, sunshineSeconds: 3600 }),
      0,
      14 * HOUR_MS,
      rules,
    );
    expect(heater?.band).toBe(4);
    expect(heater?.reason).toContain("14 h of sun");
  });

  it("mentions rain first when a wet hour decides", () => {
    const wet = [...hours(7), hour(7, { precipitationMm: 1 })];
    const quote = ruleQuote("laundry_line", wet, 0, 8 * HOUR_MS, rules);
    expect(quote?.band).toBe(0);
    expect(quote?.reason).toContain("rain is forecast in 1 hour");
  });

  it("has no quote when the forecast has a hole in the window, for every chore", () => {
    const holed = hours(12).filter((_h, index) => index !== 4);
    for (const chore of ["plants", "laundry_line", "laundry_tonight", "ac", "heater"] as const) {
      expect(ruleQuote(chore, holed, 0, 12 * HOUR_MS, rules)).toBeNull();
    }
  });
});

describe("config/rules.json is read strictly (no tuning, no silent typos)", () => {
  const raw = (): Record<string, unknown> =>
    readJsonFile(`${CONFIG_DIR}rules.json`) as Record<string, unknown>;

  it("parses the committed file", () => {
    expect(() => parseRulesConfig(raw())).not.toThrow();
  });

  it("refuses an unknown key at the top and inside a chore", () => {
    expect(() => parseRulesConfig({ ...raw(), surprise: 1 })).toThrow("Invalid rules config");
    const config = JSON.parse(JSON.stringify(raw())) as { chores: { ac: Record<string, unknown> } };
    config.chores.ac["nightMinRows"] = [];
    expect(() => parseRulesConfig(config)).toThrow("Invalid rules config");
  });

  it("refuses a file without the safety backstop", () => {
    const without = raw();
    delete without["safetyBackstop"];
    expect(() => parseRulesConfig(without)).toThrow("Invalid rules config");
  });
});
