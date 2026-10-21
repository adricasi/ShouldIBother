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
  OUTCOME_CHORES,
  IncompleteWeatherError,
  addDays,
  dateRange,
  madridWallTimeToEpochMs,
  outcomeLabel,
  type OutcomeChore,
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
  readonly chore: OutcomeChore;
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
  | "window_crosses_split"
  | "no_sunset"
  | "incomplete_archive_window"
  | "incomplete_forecast";

export interface SkippedDay {
  readonly chore: OutcomeChore;
  readonly date: string;
  readonly reason: SkipReason;
}

export interface Dataset {
  /** The snapshot's last archive day: the hold-out ends here (recorded in the manifest). */
  readonly snapshotEndDate: string;
  readonly train: readonly TrainingRow[];
  readonly holdout: readonly HoldoutRow[];
  readonly skipped: readonly SkippedDay[];
  readonly droppedFeatures: Readonly<Record<OutcomeChore, readonly string[]>>;
}

export function buildDataset(snapshot: WeatherSnapshot): Dataset {
  const recorded = archiveHours(snapshot);
  const trainingCutoffMs = madridWallTimeToEpochMs(addDays(TRAINING_END_DATE, 1), "00:00");
  const firstDate =
    snapshot.startDate < TRAINING_START_DATE ? snapshot.startDate : TRAINING_START_DATE;

  const skipped: SkippedDay[] = [];
  const trainingDays: (RowBase & { split: "train" })[] = [];
  const holdoutRows: HoldoutRow[] = [];

  for (const chore of OUTCOME_CHORES) {
    for (const date of dateRange(firstDate, snapshot.endDate)) {
      const skip = (reason: SkipReason): void => {
        skipped.push({ chore, date, reason });
      };
      const split = splitOf(date, snapshot.endDate);
      if (split === undefined || date < snapshot.startDate) {
        skip("outside_periods");
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

      const forecast = decisionForecast(snapshot, chore, date);
      const features = choreFeatures(chore, toHourlyWeather(forecast.hours), window);
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
  const { targets, droppedFeatures } = computeTargetBands(examples);
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
  };
}
