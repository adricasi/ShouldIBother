import { describe, expect, it } from "vitest";

import {
  ADVICE_CHORE_TYPES,
  advicesDiffer,
  adviceContradiction,
  adviceHeadline,
  isAdviceChore,
  ruleAdvice,
  whenLabel,
  type AdviceChore,
} from "../../src/domain/advice.js";
import { loadAdviceRules } from "../../src/server/advice-rules.js";
import { isChoreType } from "../../src/domain/chores.js";
import { BACKTEST_CHORES, OUTCOME_CHORES } from "../../src/domain/outcomes.js";
import { HOUR_MS, madridWallTimeToEpochMs } from "../../src/domain/time.js";
import type { ForecastHour } from "../../src/domain/weather.js";

const CONFIG = loadAdviceRules();
const START = madridWallTimeToEpochMs("2026-10-22", "09:00");

/** `count` hours from Thursday 09:00: mild, calm, dry, unless `change` says otherwise. */
function forecast(
  count: number,
  change: (index: number) => Partial<ForecastHour> = () => ({}),
): ForecastHour[] {
  return Array.from({ length: count }, (_unused, index) => ({
    startsAt: START + index * HOUR_MS,
    precipitationMm: 0,
    precipitationProbabilityPct: 5,
    temperatureC: 18,
    dewPointC: 8,
    relativeHumidityPct: 55,
    windKmh: 10,
    gustKmh: 20,
    sunshineSeconds: 1800,
    weatherCode: 1,
    isDay: true,
    ...change(index),
  }));
}

/** Rain of `mm` in each hour from `from` up to (not including) `to`. */
const rainBetween =
  (from: number, to: number, mm = 1) =>
  (index: number): Partial<ForecastHour> =>
    index >= from && index < to ? { precipitationMm: mm } : {};

describe("AC-031.2: the rule advice for each advice chore (design.md, Advice cards)", () => {
  it("knows the four advice chore types and nothing else", () => {
    expect([...ADVICE_CHORE_TYPES]).toEqual([
      "windows_clean",
      "balcony_sweep",
      "outdoor_paint",
      "lawn_feed",
    ]);
    expect(isAdviceChore("windows_clean")).toBe(true);
    expect(isAdviceChore("car_rinse")).toBe(false);
  });

  describe("clean windows", () => {
    it("says do it now when no hour in the next 48 is wet (under 0.1 mm)", () => {
      expect(ruleAdvice("windows_clean", forecast(72, rainBetween(10, 20, 0.09)), CONFIG)).toEqual({
        advice: "do_now",
      });
    });

    it("waits until 6 hours after the end of the last wet hour", () => {
      // Wet hours 5..9 (the last is hour 9, which ends at 10): wait from 10 + 6 = 16.
      const advice = ruleAdvice("windows_clean", forecast(72, rainBetween(5, 10)), CONFIG);
      expect(advice).toEqual({
        advice: "wait",
        window: { startHoursAhead: 16, endHoursAhead: 28 },
      });
    });

    it("ignores rain after the first 48 hours", () => {
      expect(ruleAdvice("windows_clean", forecast(72, rainBetween(50, 60)), CONFIG)).toEqual({
        advice: "do_now",
      });
    });

    it("counts a light shower of 0.1 mm as a wet hour", () => {
      const advice = ruleAdvice("windows_clean", forecast(72, rainBetween(2, 13, 0.1)), CONFIG);
      expect(advice).toEqual({
        advice: "wait",
        window: { startHoursAhead: 19, endHoursAhead: 31 },
      });
    });
  });

  describe("sweep the balcony", () => {
    it("says do it now when no gust reaches 40 km/h in the next 24 hours", () => {
      expect(
        ruleAdvice(
          "balcony_sweep",
          forecast(72, (i) => (i === 30 ? { gustKmh: 70 } : {})),
          CONFIG,
        ),
      ).toEqual({ advice: "do_now" });
    });

    it("waits until 3 hours after the last gust of 40 km/h or more", () => {
      const advice = ruleAdvice(
        "balcony_sweep",
        forecast(72, (i) => (i === 4 || i === 8 ? { gustKmh: 40 } : {})),
        CONFIG,
      );
      // The last such hour is hour 8, which ends at 9: wait from 9 + 3 = 12.
      expect(advice).toEqual({
        advice: "wait",
        window: { startHoursAhead: 12, endHoursAhead: 24 },
      });
    });
  });

  describe("paint or varnish outdoors", () => {
    it("says do it now when the first 24 hours are dry, under 85 % humidity and 10 °C or warmer", () => {
      expect(ruleAdvice("outdoor_paint", forecast(72), CONFIG)).toEqual({ advice: "do_now" });
    });

    it("waits for the first such run of 24 hours", () => {
      // Rain in hours 0..5 spoils the start; hours 6.. are clear.
      const advice = ruleAdvice("outdoor_paint", forecast(72, rainBetween(0, 6)), CONFIG);
      expect(advice).toEqual({ advice: "wait", window: { startHoursAhead: 6, endHoursAhead: 30 } });
    });

    it.each([
      ["a humidity of 85 %", { relativeHumidityPct: 85 }],
      ["a temperature of 9.9 °C", { temperatureC: 9.9 }],
      ["a missing humidity", { relativeHumidityPct: null }],
    ])("does not accept an hour with %s", (_name, bad) => {
      const advice = ruleAdvice(
        "outdoor_paint",
        forecast(72, (i) => (i === 3 ? bad : {})),
        CONFIG,
      );
      expect(advice).toEqual({ advice: "wait", window: { startHoursAhead: 4, endHoursAhead: 28 } });
    });

    it("accepts exactly 10 °C and 84 % humidity", () => {
      expect(
        ruleAdvice(
          "outdoor_paint",
          forecast(72, () => ({ temperatureC: 10, relativeHumidityPct: 84 })),
          CONFIG,
        ),
      ).toEqual({ advice: "do_now" });
    });

    it("says no window when no run of 24 hours fits in the 72 hours", () => {
      // A wet hour every 20 hours: no 24 hour run.
      const wet = (i: number): Partial<ForecastHour> =>
        i % 20 === 10 ? { precipitationMm: 1 } : {};
      expect(ruleAdvice("outdoor_paint", forecast(72, wet), CONFIG)).toEqual({
        advice: "no_window",
      });
    });
  });

  describe("feed the lawn", () => {
    it("says do it now when under 10 mm falls in the next 48 hours", () => {
      expect(ruleAdvice("lawn_feed", forecast(72, rainBetween(5, 14, 1)), CONFIG)).toEqual({
        advice: "do_now",
      });
    });

    it("waits until after the rain when 10 mm or more falls", () => {
      // 10 mm over hours 6..15: wait from hour 16.
      const advice = ruleAdvice("lawn_feed", forecast(72, rainBetween(6, 16, 1)), CONFIG);
      expect(advice).toEqual({
        advice: "wait",
        window: { startHoursAhead: 16, endHoursAhead: 40 },
      });
    });
  });

  it("pushes a wait later while its own window still holds a gust or a wet hour, and gives up at the end", () => {
    // Gusts for 30 hours: the last gust in the 24 h lookahead is hour 23, but hours 24-29 are gusty too.
    const storm = forecast(72, (i) => (i < 30 ? { gustKmh: 80 } : {}));
    expect(ruleAdvice("balcony_sweep", storm, CONFIG)).toEqual({
      advice: "wait",
      window: { startHoursAhead: 33, endHoursAhead: 45 },
    });
    const endless = forecast(72, () => ({ gustKmh: 80 }));
    expect(ruleAdvice("balcony_sweep", endless, CONFIG)).toEqual({ advice: "no_window" });
    expect(ruleAdvice("windows_clean", forecast(72, rainBetween(0, 72)), CONFIG)).toEqual({
      advice: "no_window",
    });
  });

  it("keeps the advice chores out of the bet chores, the backtest and the dataset", () => {
    for (const chore of ADVICE_CHORE_TYPES) {
      expect(isChoreType(chore)).toBe(false);
      expect(OUTCOME_CHORES).not.toContain(chore);
      expect(BACKTEST_CHORES).not.toContain(chore);
    }
  });

  it("reads a missing precipitation or gust as none: it never invents rain", () => {
    const missing = forecast(72, () => ({ precipitationMm: null, gustKmh: null }));
    expect(ruleAdvice("windows_clean", missing, CONFIG)).toEqual({ advice: "do_now" });
    expect(ruleAdvice("balcony_sweep", missing, CONFIG)).toEqual({ advice: "do_now" });
    expect(ruleAdvice("lawn_feed", missing, CONFIG)).toEqual({ advice: "do_now" });
  });
});

describe("AC-031.2: a Gemma window the forecast contradicts is refused", () => {
  const wait = (startHoursAhead: number, endHoursAhead: number) =>
    ({ advice: "wait", window: { startHoursAhead, endHoursAhead } }) as const;

  it("clean windows: refuses a window with a wet hour in it", () => {
    const hours = forecast(72, rainBetween(20, 22));
    expect(adviceContradiction("windows_clean", hours, wait(18, 24), CONFIG)).toMatch(
      /contains a wet hour \(hour 20 ahead, 1 mm\)/,
    );
  });

  it("clean windows: refuses a window that starts before the last wet hour of the next 48 hours", () => {
    const hours = forecast(72, rainBetween(5, 10));
    // Hours 12..16 are dry but the window starts after the last wet hour 9: fine.
    expect(adviceContradiction("windows_clean", hours, wait(10, 14), CONFIG)).toBeUndefined();
    // A window beginning at or before hour 9 is refused even when its own hours are dry.
    const split = forecast(72, (i) => (i === 3 || i === 30 ? { precipitationMm: 1 } : {}));
    expect(adviceContradiction("windows_clean", split, wait(10, 14), CONFIG)).toMatch(
      /starts before the last wet hour of the next 48 hours \(hour 30 ahead\)/,
    );
  });

  it("clean windows: a drizzle of 0.1 mm is a wet hour too", () => {
    const hours = forecast(72, rainBetween(30, 33, 0.1));
    expect(adviceContradiction("windows_clean", hours, wait(2, 6), CONFIG)).toMatch(
      /starts before the last wet hour/,
    );
    expect(adviceContradiction("windows_clean", hours, wait(40, 44), CONFIG)).toBeUndefined();
  });

  it("sweep: refuses a window with an hour of gusts of 40 km/h or more", () => {
    const hours = forecast(72, (i) => (i === 7 ? { gustKmh: 55 } : {}));
    expect(adviceContradiction("balcony_sweep", hours, wait(6, 9), CONFIG)).toMatch(
      /gusts of 55 km\/h \(hour 7 ahead\)/,
    );
    expect(adviceContradiction("balcony_sweep", hours, wait(8, 12), CONFIG)).toBeUndefined();
  });

  it("paint: refuses a window with forecast rain in its first 24 hours (the spec's example)", () => {
    const hours = forecast(72, rainBetween(10, 12));
    expect(adviceContradiction("outdoor_paint", hours, wait(2, 26), CONFIG)).toMatch(
      /wet, humid or cold for paint \(hour 10 ahead\)/,
    );
  });

  it("paint: refuses a humid or cold hour in the first 24 hours, but looks no further than 24", () => {
    const humid = forecast(72, (i) => (i === 5 ? { relativeHumidityPct: 90 } : {}));
    expect(adviceContradiction("outdoor_paint", humid, wait(0, 24), CONFIG)).toBeDefined();
    const cold = forecast(72, (i) => (i === 40 ? { temperatureC: 4 } : {}));
    expect(adviceContradiction("outdoor_paint", cold, wait(10, 48), CONFIG)).toBeUndefined();
  });

  it("lawn: refuses a window before the end of a spell of 10 mm or more", () => {
    const hours = forecast(72, rainBetween(10, 20, 1.2));
    expect(adviceContradiction("lawn_feed", hours, wait(2, 6), CONFIG)).toMatch(
      /starts before the heavy rain ends \(hours 10-20 ahead\)/,
    );
    expect(adviceContradiction("lawn_feed", hours, wait(20, 30), CONFIG)).toBeUndefined();
  });

  it("lawn: a spell is consecutive wet hours: two showers of 6 mm apart are not one", () => {
    const hours = forecast(72, (i) =>
      i === 10 || i === 11 || i === 20 || i === 21 ? { precipitationMm: 3 } : {},
    );
    expect(ruleAdvice("lawn_feed", hours, CONFIG)).toEqual({ advice: "do_now" });
    expect(adviceContradiction("lawn_feed", hours, wait(2, 6), CONFIG)).toBeUndefined();
  });

  it("lawn: a spell that starts after 48 hours is ignored, and one that runs past 72 hours leaves no window", () => {
    expect(ruleAdvice("lawn_feed", forecast(72, rainBetween(50, 60, 2)), CONFIG)).toEqual({
      advice: "do_now",
    });
    expect(ruleAdvice("lawn_feed", forecast(72, rainBetween(40, 72, 2)), CONFIG)).toEqual({
      advice: "no_window",
    });
  });

  it("lawn: does not refuse a window when the rain is under 10 mm", () => {
    const hours = forecast(72, rainBetween(10, 20, 0.5));
    expect(adviceContradiction("lawn_feed", hours, wait(2, 6), CONFIG)).toBeUndefined();
  });

  it("checks a do-it-now as a window that starts now", () => {
    const rainSoon = forecast(72, rainBetween(1, 3));
    expect(adviceContradiction("windows_clean", rainSoon, { advice: "do_now" }, CONFIG)).toMatch(
      /doing it now contains a wet hour/,
    );
    const calm = forecast(72);
    for (const chore of ADVICE_CHORE_TYPES) {
      expect(adviceContradiction(chore, calm, { advice: "do_now" }, CONFIG)).toBeUndefined();
    }
    const heavy = forecast(72, rainBetween(10, 20, 1.2));
    expect(adviceContradiction("lawn_feed", heavy, { advice: "do_now" }, CONFIG)).toBeDefined();
  });

  it("refuses 'no window' when the rule finds a window, and accepts it when the rule finds none", () => {
    expect(
      adviceContradiction("balcony_sweep", forecast(72), { advice: "no_window" }, CONFIG),
    ).toMatch(/allows doing it now/);
    expect(
      adviceContradiction(
        "windows_clean",
        forecast(72, rainBetween(5, 10)),
        { advice: "no_window" },
        CONFIG,
      ),
    ).toMatch(/good window from hour 16 ahead/);
    expect(
      adviceContradiction(
        "outdoor_paint",
        forecast(72, rainBetween(10, 72)),
        { advice: "no_window" },
        CONFIG,
      ),
    ).toBeUndefined();
  });

  it("paint: a window must leave 24 hours inside the 72", () => {
    expect(adviceContradiction("outdoor_paint", forecast(72), wait(50, 72), CONFIG)).toMatch(
      /leaves less than 24 hours/,
    );
    expect(
      adviceContradiction("outdoor_paint", forecast(72), wait(48, 72), CONFIG),
    ).toBeUndefined();
  });

  it("refuses a window that starts after the forecast it was given", () => {
    expect(adviceContradiction("windows_clean", forecast(60), wait(60, 66), CONFIG)).toMatch(
      /after the 60 forecast hours/,
    );
  });

  it("accepts the rule's own advice for every chore on every shape of weather", () => {
    const weathers: Record<string, (index: number) => Partial<ForecastHour>> = {
      calm: () => ({}),
      rain: rainBetween(5, 15, 1.5),
      gusts: (i) => (i < 6 ? { gustKmh: 60 } : {}),
      cold: (i) => (i < 30 ? { temperatureC: 5 } : {}),
      soaked: rainBetween(0, 48, 2),
    };
    for (const chore of ADVICE_CHORE_TYPES as readonly AdviceChore[]) {
      for (const [name, change] of Object.entries(weathers)) {
        const hours = forecast(72, change);
        const rule = ruleAdvice(chore, hours, CONFIG);
        expect(adviceContradiction(chore, hours, rule, CONFIG), `${chore} on ${name}`).toBe(
          undefined,
        );
      }
    }
  });
});

describe("AC-031.2: when Gemma's advice and the rule's differ", () => {
  it("differs by kind, or by a wait that starts 3 or more hours apart", () => {
    const wait = (start: number) =>
      ({ advice: "wait", window: { startHoursAhead: start, endHoursAhead: start + 12 } }) as const;
    expect(advicesDiffer({ advice: "do_now" }, { advice: "do_now" })).toBe(false);
    expect(advicesDiffer({ advice: "do_now" }, { advice: "no_window" })).toBe(true);
    expect(advicesDiffer(wait(10), wait(12))).toBe(false);
    expect(advicesDiffer(wait(10), wait(13))).toBe(true);
    expect(advicesDiffer(wait(10), { advice: "do_now" })).toBe(true);
  });
});

describe("AC-031.1: the headline names the time in Madrid", () => {
  const now = madridWallTimeToEpochMs("2026-10-22", "09:30");

  it("says 'Clean the windows after Thursday 14:00' for a wait that starts then", () => {
    // Forecast hour 0 is Monday 2026-10-19 09:00; 5 days of weekday arithmetic is avoided by using
    // the same start as the clock: 09:00 Thursday + 53 h = Saturday 14:00.
    const headline = adviceHeadline(
      "windows_clean",
      { advice: "wait", window: { startHoursAhead: 53, endHoursAhead: 65 } },
      START,
      now,
    );
    expect(headline).toBe("Clean the windows after Saturday 14:00");
  });

  it("uses today and tomorrow for the next two days", () => {
    expect(whenLabel(START + 5 * HOUR_MS, now)).toBe("today 14:00");
    expect(whenLabel(START + 22 * HOUR_MS, now)).toBe("tomorrow 07:00");
  });

  it("gives the plain words for now, paint's 'from' and no window", () => {
    expect(adviceHeadline("balcony_sweep", { advice: "do_now" }, START, now)).toBe(
      "Sweep the balcony now",
    );
    expect(
      adviceHeadline(
        "outdoor_paint",
        { advice: "wait", window: { startHoursAhead: 24, endHoursAhead: 48 } },
        START,
        now,
      ),
    ).toBe("Paint or varnish outdoors from tomorrow 09:00");
    expect(adviceHeadline("lawn_feed", { advice: "no_window" }, START, now)).toBe(
      "No good time to feed the lawn in the next 72 h",
    );
  });
});
