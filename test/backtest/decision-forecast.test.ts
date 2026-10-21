import { beforeAll, describe, expect, it } from "vitest";

import {
  FORECAST_QUALITY_LABELS,
  LookaheadError,
  assertIssuedBefore,
  decisionForecast,
  issuedAtMs,
  toHourlyWeather,
  type ForecastHour,
  type ForecastSource,
  type WeatherSnapshot,
} from "../../src/backtest/index.js";
import {
  HOUR_MS,
  OUTCOME_CHORES,
  addDays,
  dateRange,
  decisionTimeMs,
  madridWallTimeToEpochMs,
  outcomeWindow,
} from "../../src/domain/outcomes.js";
import { syntheticSnapshot } from "./support/synthetic-weather.js";

const DAY1_ONLY = new Set<ForecastSource>(["previous_runs_day1"]);
const EVERY_SOURCE = new Set<ForecastSource>([
  "previous_runs_day1",
  "historical_forecast",
  "archive",
]);

let snapshot: WeatherSnapshot;
beforeAll(async () => {
  snapshot = await syntheticSnapshot({ startDate: "2026-03-26", requestedEndDate: "2026-10-30" });
});

describe("AC-018.1: no lookahead", () => {
  it("uses only values issued before the decision time, for every chore and every day", () => {
    let checked = 0;
    for (const chore of OUTCOME_CHORES) {
      for (const date of dateRange("2026-03-27", "2026-10-28")) {
        const forecast = decisionForecast(snapshot, chore, date);
        expect(forecast.decisionAtMs).toBe(decisionTimeMs(chore, date));
        for (const hour of forecast.hours) {
          for (const value of Object.values(hour.values)) {
            // independent of the implementation: a day-1 value for hour H was issued by H - 24 h
            expect(value.source).toBe("previous_runs_day1");
            expect(hour.timeMs - 24 * HOUR_MS).toBeLessThan(forecast.decisionAtMs);
            expect(value.issuedAtMs).toBeLessThan(forecast.decisionAtMs);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("fails when a decision is made before a model run that it uses started", () => {
    for (const chore of OUTCOME_CHORES) {
      const date = "2026-07-15";
      const sunset = madridWallTimeToEpochMs(date, "21:20");
      const window = outcomeWindow(chore, date, sunset);
      // a decision 25 h before the window opens cannot see any day-1 run for it
      const tooEarly = window.startMs - 25 * HOUR_MS;
      expect(() => decisionForecast(snapshot, chore, date, { decisionAtMs: tooEarly })).toThrow(
        LookaheadError,
      );
    }
  });

  it("reports which value leaked", () => {
    const date = "2026-07-15";
    const window = outcomeWindow("plants", date);
    const decisionAtMs = window.endMs - 30 * HOUR_MS;
    try {
      decisionForecast(snapshot, "plants", date, { decisionAtMs });
      expect.unreachable("expected a LookaheadError");
    } catch (error) {
      expect(error).toBeInstanceOf(LookaheadError);
      const leak = error as LookaheadError;
      expect(leak.decisionAtMs).toBe(decisionAtMs);
      expect(leak.issuedAtMs).toBeGreaterThanOrEqual(decisionAtMs);
      expect(leak.message).toMatch(/lookahead/);
    }
  });

  it("treats a run that started exactly at the decision time as not yet available", () => {
    const hourMs = madridWallTimeToEpochMs("2026-07-16", "10:00");
    const hours: ForecastHour[] = [
      {
        timeMs: hourMs,
        values: {
          precipitation: {
            value: 1,
            source: "previous_runs_day1",
            issuedAtMs: hourMs - 24 * HOUR_MS,
          },
        },
      },
    ];
    expect(() => assertIssuedBefore(hours, hourMs - 24 * HOUR_MS, DAY1_ONLY)).toThrow(
      LookaheadError,
    );
    expect(() => assertIssuedBefore(hours, hourMs - 24 * HOUR_MS + 1, DAY1_ONLY)).not.toThrow();
  });

  it("catches a decision built from recorded or short-lead values", () => {
    // What a leaky implementation would build: archive and stitched-run values for the window.
    const date = "2026-07-15";
    const decisionAtMs = decisionTimeMs("plants", date);
    const window = outcomeWindow("plants", date);
    const leaky: ForecastHour[] = [window.startMs + 3 * HOUR_MS].map((timeMs) => ({
      timeMs,
      values: {
        precipitation: { value: 0, source: "archive", issuedAtMs: issuedAtMs("archive", timeMs) },
      },
    }));
    expect(() => assertIssuedBefore(leaky, decisionAtMs, EVERY_SOURCE)).toThrow(LookaheadError);
    expect(() => assertIssuedBefore(leaky, decisionAtMs, DAY1_ONLY)).not.toThrow();
  });

  it("bounds a day-1 value by 24 h before its hour", () => {
    const hourMs = madridWallTimeToEpochMs("2026-07-16", "07:00");
    expect(issuedAtMs("previous_runs_day1", hourMs)).toBe(hourMs - 24 * HOUR_MS);
    expect(issuedAtMs("historical_forecast", hourMs)).toBe(hourMs);
    expect(issuedAtMs("archive", hourMs)).toBe(hourMs);
  });

  it("covers the whole window with hours", () => {
    const forecast = decisionForecast(snapshot, "plants", "2026-07-15");
    expect(forecast.hours).toHaveLength(15);
    expect(forecast.hours[0]?.timeMs).toBe(forecast.window.startMs);
    expect(toHourlyWeather(forecast.hours)[0]?.precipitationMm).not.toBeNull();
    expect(toHourlyWeather(forecast.hours)[0]?.et0Mm).toBeNull(); // not a forecast variable
  });
});

describe("AC-018.2: labelled fallbacks", () => {
  it("labels day-1 data as such", () => {
    const forecast = decisionForecast(snapshot, "plants", "2026-07-15");
    expect(forecast.quality).toBe("day1_previous_runs");
    expect(forecast.qualityLabel).toBe(FORECAST_QUALITY_LABELS.day1_previous_runs);
  });

  it("falls back to Historical Forecast and labels it short-lead (optimistic)", async () => {
    const withoutProbability = await syntheticSnapshot({
      requestedEndDate: "2026-04-20",
      previousRunsOmit: ["precipitation_probability"],
    });
    const forecast = decisionForecast(withoutProbability, "plants", "2026-04-10");
    expect(forecast.quality).toBe("short_lead_forecast_optimistic");
    expect(forecast.qualityLabel).toBe("short-lead forecast (optimistic)");
    const probability = forecast.hours.map((hour) => hour.values.precipitation_probability);
    expect(probability.every((value) => value?.source === "historical_forecast")).toBe(true);
    // other variables still come from day-1 runs
    expect(
      forecast.hours.every((hour) => hour.values.precipitation?.source === "previous_runs_day1"),
    ).toBe(true);
    // the labelled fallback is not claimed as lookahead-free
    expect(() => assertIssuedBefore(forecast.hours, forecast.decisionAtMs, EVERY_SOURCE)).toThrow(
      LookaheadError,
    );
  });

  it("falls back to recorded weather and labels it a perfect-forecast upper bound", async () => {
    const onlyRecorded = await syntheticSnapshot({
      requestedEndDate: "2026-04-20",
      previousRunsOmit: ["precipitation_probability", "temperature_2m", "precipitation"],
      historicalOmit: ["precipitation_probability", "temperature_2m", "precipitation"],
    });
    const forecast = decisionForecast(onlyRecorded, "plants", "2026-04-10");
    expect(forecast.quality).toBe("perfect_forecast_upper_bound");
    expect(forecast.qualityLabel).toBe("perfect-forecast upper bound");
  });

  it("uses no fallback when it is not allowed", async () => {
    const withoutProbability = await syntheticSnapshot({
      requestedEndDate: "2026-04-20",
      previousRunsOmit: ["precipitation_probability"],
    });
    const forecast = decisionForecast(withoutProbability, "plants", "2026-04-10", {
      allowFallback: false,
    });
    expect(forecast.quality).toBe("day1_previous_runs");
    expect(
      forecast.hours.every((hour) => hour.values.precipitation_probability === undefined),
    ).toBe(true);
  });

  it("falls back per value when day-1 data is missing for a day", async () => {
    const gap = await syntheticSnapshot({
      requestedEndDate: "2026-04-20",
      previousRunsNullDates: ["2026-04-11"],
    });
    const forecast = decisionForecast(gap, "plants", "2026-04-10");
    const sources = new Set(forecast.hours.map((hour) => hour.values.precipitation?.source));
    expect(sources).toEqual(new Set(["previous_runs_day1", "historical_forecast"]));
    expect(forecast.quality).toBe("short_lead_forecast_optimistic");
  });

  it("needs a sunset for laundry tonight", () => {
    const { [addDays("2026-07-15", 0)]: _removed, ...rest } = snapshot.sunsetMsByDate;
    void _removed;
    expect(() =>
      decisionForecast({ ...snapshot, sunsetMsByDate: rest }, "laundry_tonight", "2026-07-15"),
    ).toThrow(/sunset/);
  });
});
