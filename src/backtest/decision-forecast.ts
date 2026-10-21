/**
 * The forecast a backtest decision is allowed to see (AC-018.1, AC-018.2).
 *
 * Every forecast value carries the instant its model run started ("issued at", or a
 * conservative upper bound for it). A decision at time T may only use Previous Runs day-1
 * values issued strictly before T; a value issued later is lookahead and raises
 * `LookaheadError`. Values from the fallback sources are allowed but labelled.
 */

import {
  HOUR_MS,
  IncompleteWeatherError,
  decisionTimeMs,
  outcomeWindow,
  windowHourStarts,
  type HourlyWeather,
  type OutcomeChore,
  type TimeWindow,
} from "../domain/outcomes.js";
import { DAY1_LEAD_HOURS, type WeatherVariable } from "./open-meteo.js";
import { VARIABLE_FIELD, indexSeries, type HourValues, type WeatherSnapshot } from "./snapshot.js";

export type ForecastSource = "previous_runs_day1" | "historical_forecast" | "archive";

export interface ForecastValue {
  readonly value: number;
  readonly source: ForecastSource;
  /** Model-run start, or a conservative upper bound for it (epoch ms). */
  readonly issuedAtMs: number;
}

export interface ForecastHour {
  readonly timeMs: number;
  readonly values: Readonly<Partial<Record<WeatherVariable, ForecastValue>>>;
}

/** Report labels (AC-018.2), worst source used wins. */
export type ForecastQuality =
  "day1_previous_runs" | "short_lead_forecast_optimistic" | "perfect_forecast_upper_bound";

export const FORECAST_QUALITY_LABELS: Readonly<Record<ForecastQuality, string>> = {
  day1_previous_runs: "day-1 lead forecast",
  short_lead_forecast_optimistic: "short-lead forecast (optimistic)",
  perfect_forecast_upper_bound: "perfect-forecast upper bound",
};

export class LookaheadError extends Error {
  constructor(
    readonly variable: string,
    readonly hourMs: number,
    readonly issuedAtMs: number,
    readonly decisionAtMs: number,
  ) {
    super(
      `lookahead: ${variable} for ${new Date(hourMs).toISOString()} was issued at ` +
        `${new Date(issuedAtMs).toISOString()}, not before the decision at ` +
        `${new Date(decisionAtMs).toISOString()}`,
    );
    this.name = "LookaheadError";
  }
}

/** Forecast variables each chore's features need. */
export const CHORE_FORECAST_VARIABLES: Readonly<Record<OutcomeChore, readonly WeatherVariable[]>> =
  {
    plants: ["precipitation", "precipitation_probability", "temperature_2m"],
    laundry_line: ["precipitation", "wind_speed_10m", "relative_humidity_2m", "sunshine_duration"],
    laundry_tonight: [
      "precipitation",
      "temperature_2m",
      "dew_point_2m",
      "wind_speed_10m",
      "relative_humidity_2m",
      "sunshine_duration",
    ],
    ac: ["temperature_2m", "wind_speed_10m"],
    heater: ["temperature_2m", "sunshine_duration"],
  };

/**
 * The instant a value for hour `hourMs` was issued, or a conservative bound.
 * Day-1 lead: the run started at most 24 h before the hour. Historical Forecast stitches the
 * first hours of many runs and the archive is reanalysis, so the only bound known is the hour
 * itself, which is why using them is "optimistic" and labelled.
 */
export function issuedAtMs(source: ForecastSource, hourMs: number): number {
  return source === "previous_runs_day1" ? hourMs - DAY1_LEAD_HOURS * HOUR_MS : hourMs;
}

/**
 * Throws `LookaheadError` if any value from one of `sources` was issued at or after the
 * decision time. The backtest checks `previous_runs_day1`; the fallbacks are labelled instead.
 */
export function assertIssuedBefore(
  hours: readonly ForecastHour[],
  decisionAtMs: number,
  sources: ReadonlySet<ForecastSource>,
): void {
  for (const hour of hours) {
    for (const [variable, forecast] of Object.entries(hour.values)) {
      if (sources.has(forecast.source) && forecast.issuedAtMs >= decisionAtMs) {
        throw new LookaheadError(variable, hour.timeMs, forecast.issuedAtMs, decisionAtMs);
      }
    }
  }
}

export function qualityOf(hours: readonly ForecastHour[]): ForecastQuality {
  let quality: ForecastQuality = "day1_previous_runs";
  for (const hour of hours) {
    for (const forecast of Object.values(hour.values)) {
      if (forecast.source === "archive") {
        return "perfect_forecast_upper_bound";
      }
      if (forecast.source === "historical_forecast") {
        quality = "short_lead_forecast_optimistic";
      }
    }
  }
  return quality;
}

export interface DecisionForecast {
  readonly chore: OutcomeChore;
  readonly date: string;
  readonly decisionAtMs: number;
  readonly window: TimeWindow;
  readonly hours: readonly ForecastHour[];
  readonly quality: ForecastQuality;
  readonly qualityLabel: string;
}

export interface DecisionForecastOptions {
  /** Defaults to the chore's fixed decision time. Tests use it to provoke lookahead. */
  readonly decisionAtMs?: number;
  /** Fall back to Historical Forecast, then the archive, when day-1 data is missing. */
  readonly allowFallback?: boolean;
  readonly variables?: readonly WeatherVariable[];
}

const indexCache = new WeakMap<
  WeatherSnapshot,
  {
    previous: Map<number, HourValues>;
    historical: Map<number, HourValues>;
    archive: Map<number, HourValues>;
  }
>();

function indexesOf(snapshot: WeatherSnapshot): {
  previous: Map<number, HourValues>;
  historical: Map<number, HourValues>;
  archive: Map<number, HourValues>;
} {
  let indexes = indexCache.get(snapshot);
  if (indexes === undefined) {
    indexes = {
      previous: indexSeries(snapshot.previousRunsDay1),
      historical: indexSeries(snapshot.historicalForecast),
      archive: indexSeries(snapshot.archive),
    };
    indexCache.set(snapshot, indexes);
  }
  return indexes;
}

/** The chore's window for a decision date, using the snapshot's sunset for laundry tonight. */
export function windowFor(
  snapshot: WeatherSnapshot,
  chore: OutcomeChore,
  date: string,
): TimeWindow {
  if (chore === "laundry_tonight") {
    const sunsetMs = snapshot.sunsetMsByDate[date];
    if (sunsetMs === undefined) {
      throw new IncompleteWeatherError(`no sunset for ${date}`);
    }
    return outcomeWindow(chore, date, sunsetMs);
  }
  return outcomeWindow(chore, date);
}

/**
 * Builds the forecast a decision at the chore's fixed time may use, for the chore's window.
 * Day-1 values are used wherever present; missing values fall back (labelled) when allowed.
 */
export function decisionForecast(
  snapshot: WeatherSnapshot,
  chore: OutcomeChore,
  date: string,
  options: DecisionForecastOptions = {},
): DecisionForecast {
  const decisionAtMs = options.decisionAtMs ?? decisionTimeMs(chore, date);
  const allowFallback = options.allowFallback ?? true;
  const variables = options.variables ?? CHORE_FORECAST_VARIABLES[chore];
  const window = windowFor(snapshot, chore, date);
  const { previous, historical, archive } = indexesOf(snapshot);

  const hours: ForecastHour[] = windowHourStarts(window).map((timeMs) => {
    const values: Partial<Record<WeatherVariable, ForecastValue>> = {};
    for (const variable of variables) {
      const day1 = previous.get(timeMs)?.[variable];
      if (day1 !== undefined && day1 !== null) {
        values[variable] = {
          value: day1,
          source: "previous_runs_day1",
          issuedAtMs: issuedAtMs("previous_runs_day1", timeMs),
        };
        continue;
      }
      if (!allowFallback) {
        continue;
      }
      const shortLead = historical.get(timeMs)?.[variable];
      if (shortLead !== undefined && shortLead !== null) {
        values[variable] = {
          value: shortLead,
          source: "historical_forecast",
          issuedAtMs: issuedAtMs("historical_forecast", timeMs),
        };
        continue;
      }
      const recorded = archive.get(timeMs)?.[variable];
      if (recorded !== undefined && recorded !== null) {
        values[variable] = {
          value: recorded,
          source: "archive",
          issuedAtMs: issuedAtMs("archive", timeMs),
        };
      }
    }
    return { timeMs, values };
  });

  assertIssuedBefore(hours, decisionAtMs, new Set<ForecastSource>(["previous_runs_day1"]));
  const quality = qualityOf(hours);
  return {
    chore,
    date,
    decisionAtMs,
    window,
    hours,
    quality,
    qualityLabel: FORECAST_QUALITY_LABELS[quality],
  };
}

/** Plain hourly numbers (provenance dropped) for feature computation. */
export function toHourlyWeather(hours: readonly ForecastHour[]): HourlyWeather[] {
  return hours.map((hour) => {
    const row: Record<string, number | null> = { timeMs: hour.timeMs };
    for (const [variable, field] of Object.entries(VARIABLE_FIELD)) {
      row[field] = hour.values[variable as WeatherVariable]?.value ?? null;
    }
    return row as unknown as HourlyWeather;
  });
}
