import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildDataset,
  parseSnapshot,
  serializeSnapshot,
  splitOf,
  choreFeatures,
  toHourlyWeather,
  type Dataset,
  type HoldoutRow,
  type SkippedDay,
  type TrainingRow,
  type WeatherSnapshot,
} from "../../src/backtest/index.js";
import {
  OUTCOME_CHORES,
  dateRange,
  madridDateOf,
  type OutcomeChore,
} from "../../src/domain/outcomes.js";
import { syntheticSnapshot, withoutVariables } from "./support/synthetic-weather.js";

const SEPTEMBER_FIRST_MS = Date.UTC(2026, 7, 31, 22, 0); // 2026-09-01 00:00 Madrid

let snapshot: WeatherSnapshot;
let dataset: Dataset;

beforeAll(async () => {
  snapshot = await syntheticSnapshot({
    startDate: "2026-03-30",
    archiveLastDay: "2026-10-09",
    requestedEndDate: "2026-10-14",
  });
  dataset = buildDataset(snapshot);
});

function skippedFor(result: Dataset, chore: OutcomeChore, reason: SkippedDay["reason"]): string[] {
  return result.skipped.filter((s) => s.chore === chore && s.reason === reason).map((s) => s.date);
}

// Several tests build the full Apr-Oct dataset (2-3 s each on an idle machine); under CI and
// coverage load they exceeded the default 5 s timeout. The assertions are unchanged.
vi.setConfig({ testTimeout: 30_000 });

describe("AC-019.1: train/hold-out split", () => {
  it("trains on 1 Apr-31 Aug and holds out 1 Sep to the archive's last day, with no date in both", () => {
    expect(snapshot.endDate).toBe("2026-10-09");
    expect(dataset.snapshotEndDate).toBe("2026-10-09");
    for (const chore of OUTCOME_CHORES) {
      const trainDates = dataset.train.filter((r) => r.chore === chore).map((r) => r.date);
      const holdoutDates = dataset.holdout.filter((r) => r.chore === chore).map((r) => r.date);
      expect(trainDates.length).toBeGreaterThan(100);
      expect(holdoutDates.length).toBeGreaterThan(30);
      expect(trainDates.every((d) => d >= "2026-04-01" && d <= "2026-08-31")).toBe(true);
      expect(holdoutDates.every((d) => d >= "2026-09-01" && d <= "2026-10-09")).toBe(true);
      expect(trainDates.filter((d) => holdoutDates.includes(d))).toEqual([]);
    }
  });

  it("ends the hold-out at the snapshot's last archive day", () => {
    const last = (chore: OutcomeChore): string | undefined =>
      dataset.holdout.filter((r) => r.chore === chore).at(-1)?.date;
    expect(last("heater")).toBe("2026-10-09");
    expect(last("laundry_line")).toBe("2026-10-09");
    // overnight chores need the next morning, which the archive does not have yet
    expect(last("plants")).toBe("2026-10-08");
    expect(skippedFor(dataset, "plants", "incomplete_archive_window")).toEqual(["2026-10-09"]);
  });

  it("splits by date only", () => {
    expect(splitOf("2026-03-31", "2026-10-09")).toBeUndefined();
    expect(splitOf("2026-04-01", "2026-10-09")).toBe("train");
    expect(splitOf("2026-08-31", "2026-10-09")).toBe("train");
    expect(splitOf("2026-09-01", "2026-10-09")).toBe("holdout");
    expect(splitOf("2026-10-09", "2026-10-09")).toBe("holdout");
    expect(splitOf("2026-10-10", "2026-10-09")).toBeUndefined();
  });

  it("skips days before 1 Apr as outside both periods", () => {
    expect(skippedFor(dataset, "heater", "outside_periods")).toEqual(["2026-03-30", "2026-03-31"]);
  });

  it("orders rows by chore, then date", () => {
    const keys = dataset.train.map((r) => `${OUTCOME_CHORES.indexOf(r.chore)}|${r.date}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("AC-019.5: no hold-out day influences a training target", () => {
  const hardRain = (timeMs: number, variable: string, value: number): number => {
    if (timeMs < SEPTEMBER_FIRST_MS) return value;
    if (variable === "precipitation") return 25;
    if (variable === "temperature_2m") return -5;
    if (variable === "et0_fao_evapotranspiration") return 0;
    return value;
  };

  it("keeps every training row and target identical when the hold-out weather changes", async () => {
    const altered = buildDataset(
      await syntheticSnapshot({
        startDate: "2026-03-30",
        archiveLastDay: "2026-10-09",
        requestedEndDate: "2026-10-14",
        archiveOverride: hardRain,
        forecastOverride: hardRain,
      }),
    );
    expect(JSON.stringify(altered.train)).toBe(JSON.stringify(dataset.train));
    // the change is real: hold-out rows differ
    expect(JSON.stringify(altered.holdout)).not.toBe(JSON.stringify(dataset.holdout));
    expect(altered.holdout.some((r) => r.chore === "plants" && r.outcome.delivered)).toBe(true);
  });

  it("keeps the training rows identical when the snapshot ends earlier", async () => {
    const shorter = buildDataset(
      await syntheticSnapshot({
        startDate: "2026-03-30",
        archiveLastDay: "2026-09-20",
        requestedEndDate: "2026-09-25",
      }),
    );
    expect(shorter.snapshotEndDate).toBe("2026-09-20");
    expect(JSON.stringify(shorter.train)).toBe(JSON.stringify(dataset.train));
  });

  it("skips the training rows of 31 Aug whose window reaches into September", () => {
    for (const chore of ["plants", "laundry_tonight", "ac"] as const) {
      expect(skippedFor(dataset, chore, "window_crosses_split")).toEqual(["2026-08-31"]);
      expect(dataset.train.some((r) => r.chore === chore && r.date === "2026-08-31")).toBe(false);
    }
    for (const chore of ["laundry_line", "heater"] as const) {
      expect(skippedFor(dataset, chore, "window_crosses_split")).toEqual([]);
      expect(dataset.train.some((r) => r.chore === chore && r.date === "2026-08-31")).toBe(true);
    }
  });

  it("never reads archive or forecast hours from September for a training row", () => {
    for (const row of dataset.train) {
      expect(row.forecast.window.endMs).toBeLessThanOrEqual(SEPTEMBER_FIRST_MS);
      expect(row.forecast.hours.every((h) => h.timeMs < SEPTEMBER_FIRST_MS)).toBe(true);
    }
  });

  it("gives hold-out rows their own outcome label and no target", () => {
    const row: HoldoutRow | undefined = dataset.holdout[0];
    expect(row).toBeDefined();
    for (const holdout of dataset.holdout) {
      expect(holdout.split).toBe("holdout");
      expect("target" in holdout).toBe(false);
      expect(typeof holdout.outcome.delivered).toBe("boolean");
    }
  });

  it("gives every training row a target from other training dates only", () => {
    const withTarget = dataset.train.filter((r) => r.target.band !== null);
    expect(withTarget.length).toBe(dataset.train.length);
    for (const row of dataset.train) {
      expect(row.target.neighbourCount).toBeLessThanOrEqual(30);
      expect(row.target.bandName).not.toBeNull();
    }
  });
});

describe("outcomes and labelled fallbacks in rows (AC-018.1, AC-018.2)", () => {
  it("decides at each chore's fixed time from day-1 forecasts", () => {
    const row = dataset.train.find((r) => r.chore === "plants" && r.date === "2026-07-15");
    expect(row?.forecastQuality).toBe("day1_previous_runs");
    expect(new Date(row?.decisionAtMs ?? 0).toISOString()).toBe("2026-07-15T17:00:00.000Z");
    expect(row?.outcome.basis).toBe("et0_minus_rain");
    expect(dataset.train.every((r) => r.forecastQuality === "day1_previous_runs")).toBe(true);
  });

  it("labels the plants outcome as rain-only when the archive has no ET0", async () => {
    const result = buildDataset(
      await syntheticSnapshot({ requestedEndDate: "2026-05-10", archiveWithoutEt0: true }),
    );
    const plants = result.train.filter((r) => r.chore === "plants");
    expect(plants.length).toBeGreaterThan(20);
    expect(plants.every((r) => r.outcome.basis === "rain_only_fallback")).toBe(true);
    const others = result.train.filter((r) => r.chore !== "plants");
    expect(others.every((r) => r.outcome.basis === "recorded_weather")).toBe(true);
  });

  it("labels short-lead forecast rows and drops the unavailable optional feature", async () => {
    const result = buildDataset(
      await syntheticSnapshot({
        requestedEndDate: "2026-05-10",
        previousRunsOmit: ["precipitation_probability"],
        historicalOmit: ["precipitation_probability"],
      }),
    );
    expect(result.droppedFeatures.plants).toEqual(["max_precipitation_probability_pct"]);
    expect(result.droppedFeatures.heater).toEqual([]);
    const plants = result.train.filter((r) => r.chore === "plants");
    expect(plants.length).toBeGreaterThan(20);

    const fallback = buildDataset(
      await syntheticSnapshot({
        requestedEndDate: "2026-05-10",
        previousRunsNullDates: ["2026-04-20"],
      }),
    );
    const labelled = fallback.train.filter((r) => r.forecastQuality !== "day1_previous_runs");
    expect(labelled.length).toBeGreaterThan(0);
    expect(
      labelled.every((r) => r.forecastQualityLabel === "short-lead forecast (optimistic)"),
    ).toBe(true);
  });

  it("skips a day whose forecast lacks a core input and reports it", () => {
    const hourToNull = (timeMs: number): boolean => madridDateOf(timeMs) === "2026-05-04";
    const nulled = (series: WeatherSnapshot["archive"]): WeatherSnapshot["archive"] => ({
      ...series,
      values: {
        ...series.values,
        temperature_2m: series.timesMs.map((time, i) =>
          hourToNull(time) ? null : (series.values.temperature_2m?.[i] ?? null),
        ),
      },
    });
    const broken: WeatherSnapshot = {
      ...snapshot,
      archive: nulled(snapshot.archive),
      previousRunsDay1: nulled(snapshot.previousRunsDay1),
      historicalForecast: nulled(snapshot.historicalForecast),
    };
    const result = buildDataset(broken);
    expect(skippedFor(result, "plants", "incomplete_forecast")).toContain("2026-05-03");
    expect(result.train.some((r) => r.chore === "plants" && r.date === "2026-05-03")).toBe(false);
    expect(skippedFor(result, "ac", "incomplete_archive_window")).toContain("2026-05-03");
  });

  it("skips laundry tonight when the sunset is unknown", () => {
    const { ["2026-06-10"]: _gone, ...rest } = snapshot.sunsetMsByDate;
    void _gone;
    const result = buildDataset({ ...snapshot, sunsetMsByDate: rest });
    expect(skippedFor(result, "laundry_tonight", "no_sunset")).toEqual(["2026-06-10"]);
  });
});

describe("recorded weather is never a model input", () => {
  it("skips days whose forecast could only be filled from the archive, with a recorded reason", async () => {
    const full = await syntheticSnapshot({ requestedEndDate: "2026-09-20" });
    const noTemperature = withoutVariables(
      withoutVariables(full, "previousRunsDay1", ["temperature_2m"]),
      "historicalForecast",
      ["temperature_2m"],
    );
    const result = buildDataset(noTemperature);
    const rows = [...result.train, ...result.holdout];
    expect(rows.some((r) => r.forecastQuality === "perfect_forecast_upper_bound")).toBe(false);
    for (const row of rows) {
      for (const hour of row.forecast.hours) {
        for (const value of Object.values(hour.values)) {
          expect(value.source).not.toBe("archive");
        }
      }
    }
    // chores that read temperature lose every day; line-dry does not use it
    for (const chore of ["plants", "laundry_tonight", "ac", "heater"] as const) {
      expect(rows.some((r) => r.chore === chore)).toBe(false);
      expect(skippedFor(result, chore, "recorded_weather_forecast").length).toBeGreaterThan(100);
    }
    expect(rows.some((r) => r.chore === "laundry_line")).toBe(true);
    expect(result.counts.skipReasons.recorded_weather_forecast).toBeGreaterThan(400);
    expect(result.counts.forecastQuality.train.perfect_forecast_upper_bound).toBe(0);
    expect(result.counts.forecastQuality.holdout.perfect_forecast_upper_bound).toBe(0);
  });
});

describe("manifest counts", () => {
  it("counts rows per split and forecast quality, plants label basis and skip reasons", () => {
    const { counts } = dataset;
    expect(counts.forecastQuality.train.day1_previous_runs).toBe(dataset.train.length);
    expect(counts.forecastQuality.holdout.day1_previous_runs).toBe(dataset.holdout.length);
    const plantsTrain = dataset.train.filter((r) => r.chore === "plants").length;
    expect(counts.plantsBasis.train).toEqual({
      et0_minus_rain: plantsTrain,
      rain_only_fallback: 0,
    });
    const totalSkipped = Object.values(counts.skipReasons).reduce((sum, n) => sum + n, 0);
    expect(totalSkipped).toBe(dataset.skipped.length);
    expect(counts.skipReasons.window_crosses_split).toBe(3);
  });

  it("counts the rain-only plants label separately", async () => {
    const result = buildDataset(
      await syntheticSnapshot({ requestedEndDate: "2026-05-10", archiveWithoutEt0: true }),
    );
    expect(result.counts.plantsBasis.train.et0_minus_rain).toBe(0);
    expect(result.counts.plantsBasis.train.rain_only_fallback).toBeGreaterThan(20);
  });

  it("exposes the features used and dropped per chore", () => {
    expect(dataset.usedFeatures.plants).toEqual([
      "rain_mm",
      "max_precipitation_probability_pct",
      "max_temperature_c",
    ]);
    expect(dataset.droppedFeatures.plants).toEqual([]);
    expect(dataset.usedFeatures.laundry_line).toEqual(["wet_hours", "mean_drying_index"]);
  });
});

describe("feature windows", () => {
  it("computes line-dry features over the rule window, 09:00 to 18:00", () => {
    const row = dataset.train.find((r) => r.chore === "laundry_line" && r.date === "2026-07-15");
    expect(row?.forecast.hours).toHaveLength(9);
    expect(new Date(row?.forecast.window.startMs ?? 0).toISOString()).toBe(
      "2026-07-15T07:00:00.000Z",
    );
    expect(
      choreFeatures(
        "laundry_line",
        toHourlyWeather(row?.forecast.hours ?? []),
        row!.forecast.window,
      ),
    ).toEqual(row?.features);
  });
});

describe("snapshot start inside the training period", () => {
  it("labels days before the snapshot start distinctly from days outside both periods", async () => {
    const late = buildDataset(
      await syntheticSnapshot({ startDate: "2026-04-03", requestedEndDate: "2026-04-30" }),
    );
    expect(skippedFor(late, "heater", "before_snapshot_start")).toEqual([
      "2026-04-01",
      "2026-04-02",
    ]);
    expect(skippedFor(late, "heater", "outside_periods")).toEqual([]);
    expect(late.train.filter((r) => r.chore === "heater")[0]?.date).toBe("2026-04-03");
  });
});

describe("AC-018.4: no photos or household data", () => {
  it("rows carry weather-derived fields only", () => {
    const keys = new Set<string>();
    for (const row of [...dataset.train, ...dataset.holdout]) {
      Object.keys(row).forEach((key) => keys.add(key));
    }
    expect([...keys].sort()).toEqual(
      [
        "chore",
        "date",
        "decisionAtMs",
        "forecast",
        "forecastQuality",
        "forecastQualityLabel",
        "features",
        "outcome",
        "split",
        "target",
      ].sort(),
    );
  });
});

describe("NFR-012: reproducibility", () => {
  it("re-running from the same snapshot gives identical output", () => {
    expect(JSON.stringify(buildDataset(snapshot))).toBe(JSON.stringify(dataset));
  });

  it("re-running from the snapshot as saved and re-read gives identical output", () => {
    const reread = parseSnapshot(JSON.parse(serializeSnapshot(snapshot)) as unknown);
    expect(JSON.stringify(buildDataset(reread))).toBe(JSON.stringify(dataset));
  });

  it("covers every day in the periods, minus the reported skips", () => {
    const rows = (list: readonly (TrainingRow | HoldoutRow)[], chore: OutcomeChore): string[] =>
      list.filter((r) => r.chore === chore).map((r) => r.date);
    for (const chore of OUTCOME_CHORES) {
      const all = new Set([...rows(dataset.train, chore), ...rows(dataset.holdout, chore)]);
      const skipped = new Set(dataset.skipped.filter((s) => s.chore === chore).map((s) => s.date));
      for (const date of dateRange("2026-03-30", "2026-10-09")) {
        expect(all.has(date) !== skipped.has(date)).toBe(true);
      }
    }
  });
});
