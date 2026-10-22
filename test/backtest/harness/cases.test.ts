import { beforeAll, describe, expect, it } from "vitest";

import { buildCases, daylightOf, type BuiltCases } from "../../../src/backtest/harness/index.js";
import type { WeatherSnapshot } from "../../../src/backtest/index.js";
import {
  DECISION_TIMES,
  HOUR_MS,
  OUTCOME_CHORES,
  decisionTimeMs,
  madridWallTimeToEpochMs,
} from "../../../src/domain/outcomes.js";
import { syntheticSnapshot, withoutVariables } from "../support/synthetic-weather.js";
import { RULES, sliceSnapshot } from "./support.js";

let snapshot: WeatherSnapshot;
let built: BuiltCases;
beforeAll(async () => {
  snapshot = await sliceSnapshot();
  built = buildCases(snapshot, RULES);
});

describe("AC-018.1: decisions at each chore's fixed time, from day-1 forecasts issued before it", () => {
  it("decides at the fixed Madrid time of the chore and uses only runs started before it", () => {
    expect(built.cases.length).toBeGreaterThan(50);
    for (const c of built.cases) {
      expect(c.input.decisionAtMs).toBe(decisionTimeMs(c.input.chore, c.input.date));
      expect(new Date(c.input.decisionAtMs).getTime()).toBe(
        madridWallTimeToEpochMs(c.input.date, DECISION_TIMES[c.input.chore]),
      );
      for (const hour of c.input.forecast.hours) {
        for (const value of Object.values(hour.values)) {
          if (value.source === "previous_runs_day1") {
            expect(value.issuedAtMs).toBeLessThan(c.input.decisionAtMs);
          }
        }
      }
    }
  });

  it("keeps the outcome out of what a strategy sees", () => {
    for (const c of built.cases) {
      expect(Object.keys(c.input)).not.toContain("delivered");
      expect(Object.keys(c.input)).not.toContain("outcome");
      expect(JSON.stringify(c.input)).not.toContain("delivered");
    }
  });

  it("plays the days in date order, every chore each day", () => {
    const dates = [...new Set(built.cases.map((c) => c.input.date))];
    expect(dates).toEqual([...dates].sort());
    const first = built.cases.filter((c) => c.input.date === "2026-08-25");
    expect(first.map((c) => c.input.chore)).toEqual([...OUTCOME_CHORES]);
  });

  it("leaves out days the archive can not label, with the reason", () => {
    // The archive ends on 6 Sep: the overnight windows of that day reach 7 Sep.
    const lastDay = built.skipped.filter((s) => s.date === "2026-09-06");
    expect(lastDay.map((s) => s.chore).sort()).toEqual(["ac", "laundry_tonight", "plants"]);
    expect(lastDay.every((s) => s.reason === "incomplete_archive_window")).toBe(true);
  });
});

describe("AC-018.3: the in-sample / hold-out split", () => {
  it("puts 24-31 Aug in the training period and 1 Sep onwards in the hold-out", () => {
    for (const c of built.cases) {
      expect(c.split).toBe(c.input.date <= "2026-08-31" ? "train" : "holdout");
    }
    expect(built.cases.some((c) => c.split === "train")).toBe(true);
    expect(built.cases.some((c) => c.split === "holdout")).toBe(true);
  });

  it("does not simulate days before 1 April", async () => {
    const early = await syntheticSnapshot({
      startDate: "2026-03-28",
      requestedEndDate: "2026-04-05",
    });
    const result = buildCases(early, RULES);
    expect(result.cases.every((c) => c.input.date >= "2026-04-01")).toBe(true);
    expect(result.skipped.filter((s) => s.reason === "outside_periods")).toHaveLength(4 * 5);
  });

  it("honours --from and --to", () => {
    const part = buildCases(snapshot, RULES, { from: "2026-08-30", to: "2026-09-02" });
    expect([...new Set(part.cases.map((c) => c.input.date))]).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

describe("AC-018.2: forecast quality is labelled", () => {
  it("is day-1 when Previous Runs has every variable", () => {
    expect(new Set(built.cases.map((c) => c.input.forecast.quality))).toEqual(
      new Set(["day1_previous_runs"]),
    );
  });

  it("is short-lead (optimistic) when a variable falls back to the Historical Forecast", () => {
    const degraded = withoutVariables(snapshot, "previousRunsDay1", ["wind_gusts_10m"]);
    const result = buildCases(degraded, RULES);
    expect(new Set(result.cases.map((c) => c.input.forecast.quality))).toEqual(
      new Set(["short_lead_forecast_optimistic"]),
    );
  });

  it("is a perfect-forecast upper bound when only recorded weather has the variable", () => {
    const degraded = withoutVariables(
      withoutVariables(snapshot, "previousRunsDay1", ["wind_gusts_10m"]),
      "historicalForecast",
      ["wind_gusts_10m"],
    );
    const result = buildCases(degraded, RULES);
    expect(new Set(result.cases.map((c) => c.input.forecast.quality))).toEqual(
      new Set(["perfect_forecast_upper_bound"]),
    );
  });
});

describe("daylight for the line-dry rule", () => {
  it("counts an hour as daylight when it starts before the day's sunset, from 08:00", () => {
    const sunset = snapshot.sunsetMsByDate["2026-08-25"]!;
    const nine = madridWallTimeToEpochMs("2026-08-25", "09:00");
    expect(daylightOf(snapshot, nine)).toBe(true);
    expect(daylightOf(snapshot, madridWallTimeToEpochMs("2026-08-25", "06:00"))).toBe(false);
    expect(daylightOf(snapshot, Math.floor(sunset / HOUR_MS) * HOUR_MS + HOUR_MS)).toBe(false);
    expect(daylightOf(snapshot, madridWallTimeToEpochMs("2027-01-01", "12:00"))).toBeNull();
  });
});
