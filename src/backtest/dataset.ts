/**
 * Train/hold-out split and per-day rows (decision forecast + outcome label) for the backtest
 * and the fine-tune dataset (REQ-018, REQ-019).
 *
 * - Training: 1 Apr-31 Aug 2026. Hold-out: 1 Sep 2026 to the snapshot's last archive day.
 * - A training row whose outcome window reaches into the hold-out period (31 Aug rows of the
 *   overnight chores) is skipped, so no hold-out weather influences a training label, feature
 *   or target (AC-019.5).
 * - Hold-out rows keep their own outcome label and never get a target.
 * - Output order is fixed (chore, then date), so re-running from the same snapshot gives the
 *   same bytes (NFR-012).
 */

import {
  BACKTEST_CHORES,
  IncompleteWeatherError,
  addDays,
  dateRange,
  madridWallTimeToEpochMs,
  outcomeLabel,
  type BacktestChore,
  type OutcomeLabel,
} from "../domain/outcomes.js";
import {
  decisionForecast,
  toHourlyWeather,
  windowFor,
  type DecisionForecast,
  type ForecastQuality,
} from "./decision-forecast.js";
import { archiveHours, type WeatherSnapshot } from "./snapshot.js";
import {
  BAND_NAMES,
  CHORE_FEATURES,
  HOLDOUT_START_DATE,
  TRAINING_END_DATE,
  TRAINING_START_DATE,
  choreFeatures,
  computeTargetBands,
  type BandIndex,
  type FeatureVector,
  type TrainingExample,
} from "./target-band.js";

export type Split = "train" | "holdout";

/** The split of a decision date, or undefined if it is in neither period. */
export function splitOf(date: string, snapshotEndDate: string): Split | undefined {
  if (date >= TRAINING_START_DATE && date <= TRAINING_END_DATE) {
    return "train";
  }
  if (date >= HOLDOUT_START_DATE && date <= snapshotEndDate) {
    return "holdout";
  }
  return undefined;
}

interface RowBase {
  readonly chore: BacktestChore;
  readonly date: string;
  readonly decisionAtMs: number;
  readonly forecastQuality: ForecastQuality;
  readonly forecastQualityLabel: string;
  readonly forecast: DecisionForecast;
  readonly features: FeatureVector;
  readonly outcome: OutcomeLabel;
}

export interface TrainingRow extends RowBase {
  readonly split: "train";
  readonly target: {
    readonly band: BandIndex | null;
    readonly bandName: string | null;
    readonly rate: number | null;
    readonly neighbourCount: number;
  };
}

/** Hold-out rows have no `target`: they are evaluation-only. */
export interface HoldoutRow extends RowBase {
  readonly split: "holdout";
}

export type SkipReason =
  | "outside_periods"
  | "before_snapshot_start"
  | "recorded_weather_forecast"
  | "window_crosses_split"
  | "no_sunset"
  | "short_lead_forecast"
  | "incomplete_archive_window"
  | "incomplete_forecast";

export interface SkippedDay {
  readonly chore: BacktestChore;
  readonly date: string;
  readonly reason: SkipReason;
}

export interface Dataset {
  /** The snapshot's last archive day: the hold-out ends here (recorded in the manifest). */
  readonly snapshotEndDate: string;
  readonly train: readonly TrainingRow[];
  readonly holdout: readonly HoldoutRow[];
  readonly skipped: readonly SkippedDay[];
  /** Features left out per chore (unavailable in some training row), for the manifest. */
  readonly droppedFeatures: Readonly<Record<BacktestChore, readonly string[]>>;
  readonly usedFeatures: Readonly<Record<BacktestChore, readonly string[]>>;
  readonly counts: DatasetCounts;
}

export type PlantsBasis = "et0_minus_rain" | "rain_only_fallback";

/** Row counts T-031 puts in the manifest. Every skipped day is counted under one reason. */
export interface DatasetCounts {
  readonly forecastQuality: Readonly<Record<Split, Readonly<Record<ForecastQuality, number>>>>;
  /** Plants rows by how their label was computed (ET0 balance or the rain-only fallback). */
  readonly plantsBasis: Readonly<Record<Split, Readonly<Record<PlantsBasis, number>>>>;
  readonly skipReasons: Readonly<Record<SkipReason, number>>;
}

const SKIP_REASONS: readonly SkipReason[] = [
  "outside_periods",
  "before_snapshot_start",
  "recorded_weather_forecast",
  "window_crosses_split",
  "no_sunset",
  "short_lead_forecast",
  "incomplete_archive_window",
  "incomplete_forecast",
];

function countRows(
  train: readonly TrainingRow[],
  holdout: readonly HoldoutRow[],
  skipped: readonly SkippedDay[],
): DatasetCounts {
  const quality = (rows: readonly (TrainingRow | HoldoutRow)[]) => ({
    day1_previous_runs: rows.filter((r) => r.forecastQuality === "day1_previous_runs").length,
    short_lead_forecast_optimistic: rows.filter(
      (r) => r.forecastQuality === "short_lead_forecast_optimistic",
    ).length,
    perfect_forecast_upper_bound: rows.filter(
      (r) => r.forecastQuality === "perfect_forecast_upper_bound",
    ).length,
  });
  const basis = (rows: readonly (TrainingRow | HoldoutRow)[]) => ({
    et0_minus_rain: rows.filter((r) => r.chore === "plants" && r.outcome.basis === "et0_minus_rain")
      .length,
    rain_only_fallback: rows.filter(
      (r) => r.chore === "plants" && r.outcome.basis === "rain_only_fallback",
    ).length,
  });
  return {
    forecastQuality: { train: quality(train), holdout: quality(holdout) },
    plantsBasis: { train: basis(train), holdout: basis(holdout) },
    skipReasons: Object.fromEntries(
      SKIP_REASONS.map((reason) => [reason, skipped.filter((s) => s.reason === reason).length]),
    ) as Record<SkipReason, number>,
  };
}

export function buildDataset(snapshot: WeatherSnapshot): Dataset {
  const recorded = archiveHours(snapshot);
  const trainingCutoffMs = madridWallTimeToEpochMs(addDays(TRAINING_END_DATE, 1), "00:00");
  const firstDate =
    snapshot.startDate < TRAINING_START_DATE ? snapshot.startDate : TRAINING_START_DATE;

  const skipped: SkippedDay[] = [];
  const trainingDays: (RowBase & { split: "train" })[] = [];
  const holdoutRows: HoldoutRow[] = [];

  for (const chore of BACKTEST_CHORES) {
    for (const date of dateRange(firstDate, snapshot.endDate)) {
      const skip = (reason: SkipReason): void => {
        skipped.push({ chore, date, reason });
      };
      const split = splitOf(date, snapshot.endDate);
      if (split === undefined) {
        skip("outside_periods");
        continue;
      }
      if (date < snapshot.startDate) {
        skip("before_snapshot_start");
        continue;
      }
      if (chore === "laundry_tonight" && snapshot.sunsetMsByDate[date] === undefined) {
        skip("no_sunset");
        continue;
      }
      const window = windowFor(snapshot, chore, date);
      if (split === "train" && window.endMs > trainingCutoffMs) {
        skip("window_crosses_split");
        continue;
      }

      let outcome: OutcomeLabel;
      try {
        outcome = outcomeLabel(chore, recorded, window);
      } catch (error) {
        if (error instanceof IncompleteWeatherError) {
          skip("incomplete_archive_window");
          continue;
        }
        throw error;
      }

      // Model inputs must be forecasts. Recorded weather would leak the outcome into the
      // features and targets, so a day that can only be filled from the archive is skipped.
      const forecast = decisionForecast(snapshot, chore, date);
      if (forecast.quality === "perfect_forecast_upper_bound") {
        skip("recorded_weather_forecast");
        continue;
      }
      const features = choreFeatures(chore, toHourlyWeather(forecast.hours), forecast.window);
      const coreMissing = CHORE_FEATURES[chore].some(
        (spec) => !spec.optional && features[spec.name] === null,
      );
      if (coreMissing) {
        skip("incomplete_forecast");
        continue;
      }

      const base: RowBase = {
        chore,
        date,
        decisionAtMs: forecast.decisionAtMs,
        forecastQuality: forecast.quality,
        forecastQualityLabel: forecast.qualityLabel,
        forecast,
        features,
        outcome,
      };
      if (split === "train") {
        // Training rows and their neighbours are day-1 forecasts only: a Historical Forecast value
        // comes from a run started after the decision, so such a day neither gets a target nor
        // counts as a neighbour of another (AGENTS.md, AC-018.1). Hold-out days keep the label.
        if (forecast.quality !== "day1_previous_runs") {
          skip("short_lead_forecast");
          continue;
        }
        trainingDays.push({ ...base, split: "train" });
      } else {
        holdoutRows.push({ ...base, split: "holdout" });
      }
    }
  }

  // Targets use training rows only: hold-out rows are never passed in.
  const examples: TrainingExample[] = trainingDays.map((day) => ({
    chore: day.chore,
    date: day.date,
    features: day.features,
    delivered: day.outcome.delivered,
  }));
  const { targets, droppedFeatures, usedFeatures } = computeTargetBands(examples);
  const targetByKey = new Map(targets.map((target) => [`${target.chore}|${target.date}`, target]));

  const train: TrainingRow[] = trainingDays.map((day) => {
    const target = targetByKey.get(`${day.chore}|${day.date}`);
    if (target === undefined) {
      throw new Error(`no target computed for ${day.chore} ${day.date}`);
    }
    return {
      ...day,
      target: {
        band: target.band,
        bandName: target.band === null ? null : BAND_NAMES[target.band],
        rate: target.rate,
        neighbourCount: target.neighbourCount,
      },
    };
  });

  return {
    snapshotEndDate: snapshot.endDate,
    train,
    holdout: holdoutRows,
    skipped,
    droppedFeatures,
    usedFeatures,
    counts: countRows(train, holdoutRows, skipped),
  };
}
