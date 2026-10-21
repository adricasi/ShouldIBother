/**
 * Neighbour-based target band for the fine-tune dataset (design.md, "Fine-tune dataset",
 * REQ-019, AC-019.5).
 *
 * For each training row: candidates are the training rows of the same chore on other dates
 * (the row's own date is excluded); features are the rule inputs for the chore's window,
 * z-scored on the training period; Euclidean distance; the k = 30 nearest (all, if fewer);
 * rate = share of neighbours whose outcome label is true; band by the fixed cut points.
 * Only Apr-Aug rows may be passed in: anything else is rejected, so no hold-out day can
 * influence a target.
 */

import {
  OUTCOME_CHORES,
  dewHours,
  dryingIndex,
  isWetHour,
  selectWindowHours,
  type HourlyWeather,
  type OutcomeChore,
  type TimeWindow,
} from "../domain/outcomes.js";

export const TRAINING_START_DATE = "2026-04-01";
export const TRAINING_END_DATE = "2026-08-31";
export const HOLDOUT_START_DATE = "2026-09-01";

export const NEIGHBOUR_COUNT = 30;

/** Ordinal band: 0 very unlikely ... 4 very likely. */
export type BandIndex = 0 | 1 | 2 | 3 | 4;
export const BAND_NAMES: Readonly<Record<BandIndex, string>> = {
  0: "very unlikely",
  1: "unlikely",
  2: "toss-up",
  3: "likely",
  4: "very likely",
};

/** Band cut points: midpoints between the band odds 85/70/50/35/15 (design.md). */
export function bandFromRate(rate: number): BandIndex {
  if (rate >= 0.775) return 4;
  if (rate >= 0.6) return 3;
  if (rate >= 0.425) return 2;
  if (rate >= 0.25) return 1;
  return 0;
}

export type FeatureVector = Readonly<Record<string, number | null>>;

interface FeatureSpec {
  readonly name: string;
  /** Optional features may be unavailable (probability): they are dropped, not row-skipping. */
  readonly optional: boolean;
}

/** Feature names per chore, in fixed order. They are the rule's inputs (design.md). */
export const CHORE_FEATURES: Readonly<Record<OutcomeChore, readonly FeatureSpec[]>> = {
  plants: [
    { name: "rain_mm", optional: false },
    { name: "max_precipitation_probability_pct", optional: true },
    { name: "max_temperature_c", optional: false },
  ],
  laundry_line: [
    { name: "wet_hours", optional: false },
    { name: "mean_drying_index", optional: false },
  ],
  laundry_tonight: [
    { name: "wet_hours", optional: false },
    { name: "dew_hours", optional: false },
    { name: "mean_drying_index", optional: false },
  ],
  ac: [
    { name: "night_min_temperature_c", optional: false },
    { name: "mean_wind_kmh", optional: false },
  ],
  heater: [
    { name: "day_max_temperature_c", optional: false },
    { name: "sunshine_hours", optional: false },
  ],
};

function allPresent(values: readonly (number | null)[]): values is number[] {
  return values.every((value) => value !== null);
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function mean(values: readonly number[]): number {
  return total(values) / values.length;
}

function meanDrying(hours: readonly HourlyWeather[]): number | null {
  const rows = hours.map((hour) =>
    hour.precipitationMm === null ||
    hour.windSpeedKmh === null ||
    hour.relativeHumidityPct === null ||
    hour.sunshineSeconds === null
      ? null
      : dryingIndex({
          precipitationMm: hour.precipitationMm,
          windSpeedKmh: hour.windSpeedKmh,
          relativeHumidityPct: hour.relativeHumidityPct,
          sunshineSeconds: hour.sunshineSeconds,
        }),
  );
  return allPresent(rows) ? mean(rows) : null;
}

/**
 * Rule-input features of a chore's window, from forecast hours (null when not available).
 * `hours` may be longer than the window; incomplete windows give all-null features.
 */
export function choreFeatures(
  chore: OutcomeChore,
  hours: readonly HourlyWeather[],
  window: TimeWindow,
): FeatureVector {
  let windowHours: HourlyWeather[];
  try {
    windowHours = selectWindowHours(hours, window);
  } catch {
    return Object.fromEntries(CHORE_FEATURES[chore].map((spec) => [spec.name, null]));
  }
  const column = (pick: (hour: HourlyWeather) => number | null): number[] | null => {
    const values = windowHours.map(pick);
    return allPresent(values) ? values : null;
  };
  const rain = column((hour) => hour.precipitationMm);
  const temperature = column((hour) => hour.temperatureC);
  const wind = column((hour) => hour.windSpeedKmh);
  const sunshine = column((hour) => hour.sunshineSeconds);
  const wetHours = rain === null ? null : rain.filter(isWetHour).length;

  switch (chore) {
    case "plants": {
      const probability = column((hour) => hour.precipitationProbabilityPct);
      return {
        rain_mm: rain === null ? null : total(rain),
        max_precipitation_probability_pct: probability === null ? null : Math.max(...probability),
        max_temperature_c: temperature === null ? null : Math.max(...temperature),
      };
    }
    case "laundry_line":
      return { wet_hours: wetHours, mean_drying_index: meanDrying(windowHours) };
    case "laundry_tonight":
      return {
        wet_hours: wetHours,
        dew_hours:
          temperature === null || column((hour) => hour.dewPointC) === null
            ? null
            : dewHours(windowHours),
        mean_drying_index: meanDrying(windowHours),
      };
    case "ac":
      return {
        night_min_temperature_c: temperature === null ? null : Math.min(...temperature),
        mean_wind_kmh: wind === null ? null : mean(wind),
      };
    case "heater":
      return {
        day_max_temperature_c: temperature === null ? null : Math.max(...temperature),
        sunshine_hours: sunshine === null ? null : total(sunshine) / 3600,
      };
  }
}

export interface TrainingExample {
  readonly chore: OutcomeChore;
  /** Decision date (Madrid). */
  readonly date: string;
  readonly features: FeatureVector;
  /** The row's own outcome label ("weather delivered"). */
  readonly delivered: boolean;
}

export interface TargetBand {
  readonly chore: OutcomeChore;
  readonly date: string;
  /** Null when there is no usable feature or no other row to compare with. */
  readonly band: BandIndex | null;
  readonly rate: number | null;
  readonly neighbourCount: number;
  /** Dates of the neighbours, nearest first (for audits and tests). */
  readonly neighbourDates: readonly string[];
}

export interface TargetBandResult {
  readonly targets: readonly TargetBand[];
  /** Features left out per chore because they were unavailable in some training row. */
  readonly droppedFeatures: Readonly<Record<OutcomeChore, readonly string[]>>;
  readonly usedFeatures: Readonly<Record<OutcomeChore, readonly string[]>>;
}

export class HoldoutLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutLeakError";
  }
}

/** Training features: those that are available in every training row of the chore. */
function usableFeatures(chore: OutcomeChore, examples: readonly TrainingExample[]): string[] {
  return CHORE_FEATURES[chore]
    .map((spec) => spec.name)
    .filter((name) => examples.every((example) => example.features[name] != null));
}

/**
 * Target band for every training example. Throws `HoldoutLeakError` for any example outside
 * 1 Apr-31 Aug 2026 and for a repeated (chore, date).
 */
export function computeTargetBands(examples: readonly TrainingExample[]): TargetBandResult {
  const seen = new Set<string>();
  for (const example of examples) {
    if (example.date < TRAINING_START_DATE || example.date > TRAINING_END_DATE) {
      throw new HoldoutLeakError(
        `${example.chore} ${example.date} is outside the training period ` +
          `${TRAINING_START_DATE} to ${TRAINING_END_DATE}`,
      );
    }
    const key = `${example.chore}|${example.date}`;
    if (seen.has(key)) {
      throw new HoldoutLeakError(`duplicate training example ${key}`);
    }
    seen.add(key);
  }

  const targets: TargetBand[] = [];
  const droppedFeatures = {} as Record<OutcomeChore, string[]>;
  const usedFeatures = {} as Record<OutcomeChore, string[]>;

  for (const chore of OUTCOME_CHORES) {
    const rows = examples
      .filter((example) => example.chore === chore)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const used = usableFeatures(chore, rows);
    usedFeatures[chore] = used;
    droppedFeatures[chore] = CHORE_FEATURES[chore]
      .map((spec) => spec.name)
      .filter((name) => !used.includes(name));

    // z-score on the training period (population standard deviation; constant -> 0).
    const raw = rows.map((row) => used.map((name) => row.features[name] ?? 0));
    const means = used.map((_, column) => mean(raw.map((vector) => vector[column] ?? 0)));
    const deviations = used.map((_, column) =>
      Math.sqrt(mean(raw.map((vector) => ((vector[column] ?? 0) - (means[column] ?? 0)) ** 2))),
    );
    const scaled = raw.map((vector) =>
      vector.map((value, column) => {
        const deviation = deviations[column] ?? 0;
        return deviation === 0 ? 0 : (value - (means[column] ?? 0)) / deviation;
      }),
    );

    rows.forEach((row, position) => {
      if (used.length === 0) {
        targets.push(emptyTarget(row));
        return;
      }
      const own = scaled[position] ?? [];
      const candidates = rows
        .map((other, otherPosition) => ({ other, otherPosition }))
        .filter(({ other }) => other.date !== row.date)
        .map(({ other, otherPosition }) => ({
          date: other.date,
          delivered: other.delivered,
          distance: Math.sqrt(
            total(
              (scaled[otherPosition] ?? []).map(
                (value, column) => (value - (own[column] ?? 0)) ** 2,
              ),
            ),
          ),
        }))
        .sort((a, b) =>
          a.distance !== b.distance ? a.distance - b.distance : a.date < b.date ? -1 : 1,
        )
        .slice(0, NEIGHBOUR_COUNT);
      if (candidates.length === 0) {
        targets.push(emptyTarget(row));
        return;
      }
      const rate = candidates.filter((candidate) => candidate.delivered).length / candidates.length;
      targets.push({
        chore,
        date: row.date,
        band: bandFromRate(rate),
        rate,
        neighbourCount: candidates.length,
        neighbourDates: candidates.map((candidate) => candidate.date),
      });
    });
  }
  return { targets, droppedFeatures, usedFeatures };
}

function emptyTarget(row: TrainingExample): TargetBand {
  return {
    chore: row.chore,
    date: row.date,
    band: null,
    rate: null,
    neighbourCount: 0,
    neighbourDates: [],
  };
}
