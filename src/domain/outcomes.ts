/**
 * Outcome labels ("weather delivered") per chore, fixed decision times, outcome windows and
 * the drying index. Pure functions over recorded hourly weather; used by the backtest, the
 * fine-tune targets and `lucky_win` (AC-008.6). See design.md, "Outcome labels".
 *
 * All wall-clock times are Europe/Madrid. Instants are epoch milliseconds (UTC).
 */

import { HOUR_MS, MADRID_TIME_ZONE, addDays, madridWallTimeToEpochMs } from "./time.js";

// The Europe/Madrid helpers live in `./time.ts`, the one implementation; re-exported here so the
// backtest and its tests keep their imports.
export {
  HOUR_MS,
  addDays,
  assertIsoDate,
  dateRange,
  madridDateOf,
  madridWallTimeToEpochMs,
} from "./time.js";
export const TIME_ZONE = MADRID_TIME_ZONE;

/** Chores that have an outcome label (listener `chore_type` values; `laundry_plan` has none). */
export const OUTCOME_CHORES = [
  "plants",
  "laundry_line",
  "laundry_tonight",
  "ac",
  "heater",
] as const;
export type OutcomeChore = (typeof OUTCOME_CHORES)[number];

/** A wet hour has precipitation >= 0.2 mm (design.md, rule baseline). */
export const WET_HOUR_MM = 0.2;

const PLANTS_MAX_NET_DEFICIT_MM = 1.0;
const PLANTS_FALLBACK_MIN_RAIN_MM = 2;
const LINE_DRY_MIN_DRYING_SUM = 3.0;
/** Dew hour: temp - dew point at most this; the label needs fewer than `DEW_HOURS_LIMIT` of them. */
export const DEW_MAX_SPREAD_C = 2;
export const DEW_HOURS_LIMIT = 3;
const AC_NIGHT_MIN_LIMIT_C = 23;
const HEATER_MAX_TEMP_C = 18;
const HEATER_SUNNY_MAX_TEMP_C = 15;
const HEATER_SUNNY_MIN_SECONDS = 5 * 3600;

/** Hourly weather for one hour, starting at `timeMs`. `null` means "not available". */
export interface HourlyWeather {
  readonly timeMs: number;
  readonly temperatureC: number | null;
  readonly dewPointC: number | null;
  readonly relativeHumidityPct: number | null;
  readonly precipitationMm: number | null;
  readonly precipitationProbabilityPct: number | null;
  readonly windSpeedKmh: number | null;
  readonly windGustsKmh: number | null;
  readonly weatherCode: number | null;
  readonly sunshineSeconds: number | null;
  readonly et0Mm: number | null;
}

/** Half-open interval [startMs, endMs). */
export interface TimeWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export type OutcomeBasis = "et0_minus_rain" | "rain_only_fallback" | "recorded_weather";

export interface OutcomeLabel {
  readonly chore: OutcomeChore;
  /** True when the weather would have done the chore. */
  readonly delivered: boolean;
  /** How the label was computed; `rain_only_fallback` is reported as such (design.md). */
  readonly basis: OutcomeBasis;
  /** The measured quantities behind the label (for reports and tests). */
  readonly measures: Readonly<Record<string, number>>;
}

/** Recorded weather lacks hours or fields the label needs. */
export class IncompleteWeatherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteWeatherError";
  }
}

// ---------------------------------------------------------------------------------------------
// Decision times and windows (design.md, Outcome labels)
// ---------------------------------------------------------------------------------------------

/** Fixed backtest decision time per chore (Madrid wall clock). */
export const DECISION_TIMES: Readonly<Record<OutcomeChore, string>> = {
  plants: "19:00",
  laundry_line: "09:00",
  laundry_tonight: "20:00",
  ac: "21:00",
  heater: "08:00",
};

/** The chore's decision instant on a Madrid date. */
export function decisionTimeMs(chore: OutcomeChore, date: string): number {
  return madridWallTimeToEpochMs(date, DECISION_TIMES[chore]);
}

/**
 * The window the outcome label looks at, for a decision made on `date`.
 * `sunsetMs` is required for `laundry_tonight` (window starts at sunset).
 */
export function outcomeWindow(chore: OutcomeChore, date: string, sunsetMs?: number): TimeWindow {
  const next = addDays(date, 1);
  switch (chore) {
    case "plants":
      return {
        startMs: madridWallTimeToEpochMs(date, DECISION_TIMES.plants),
        endMs: madridWallTimeToEpochMs(next, "10:00"),
      };
    case "laundry_line":
      return {
        startMs: madridWallTimeToEpochMs(date, "10:00"),
        endMs: madridWallTimeToEpochMs(date, "18:00"),
      };
    case "laundry_tonight":
      if (sunsetMs === undefined) {
        throw new Error("laundry_tonight needs the sunset instant for its window");
      }
      return { startMs: sunsetMs, endMs: madridWallTimeToEpochMs(next, "08:00") };
    case "ac":
      return {
        startMs: madridWallTimeToEpochMs(date, "22:00"),
        endMs: madridWallTimeToEpochMs(next, "07:00"),
      };
    case "heater":
      return {
        startMs: madridWallTimeToEpochMs(date, DECISION_TIMES.heater),
        endMs: madridWallTimeToEpochMs(date, "22:00"),
      };
  }
}

/**
 * Start instants of every hour that overlaps the window (so the hour containing a mid-hour
 * sunset is included).
 */
export function windowHourStarts(window: TimeWindow): number[] {
  const starts: number[] = [];
  for (
    let hour = Math.floor(window.startMs / HOUR_MS) * HOUR_MS;
    hour < window.endMs;
    hour += HOUR_MS
  ) {
    starts.push(hour);
  }
  return starts;
}

/** The window's hours in time order; throws if any hour is missing. */
export function selectWindowHours(
  hours: readonly HourlyWeather[],
  window: TimeWindow,
): HourlyWeather[] {
  const byTime = new Map<number, HourlyWeather>();
  for (const hour of hours) {
    byTime.set(hour.timeMs, hour);
  }
  const selected: HourlyWeather[] = [];
  const missing: number[] = [];
  for (const start of windowHourStarts(window)) {
    const hour = byTime.get(start);
    if (hour === undefined) {
      missing.push(start);
    } else {
      selected.push(hour);
    }
  }
  if (missing.length > 0) {
    throw new IncompleteWeatherError(
      `${missing.length} of ${windowHourStarts(window).length} window hours are missing, ` +
        `the first at ${new Date(missing[0] ?? 0).toISOString()}`,
    );
  }
  return selected;
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

/** Removes floating-point noise before comparing a sum with a bound. */
function settle(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function requireField(
  hours: readonly HourlyWeather[],
  field: keyof Omit<HourlyWeather, "timeMs">,
): number[] {
  const values: number[] = [];
  for (const hour of hours) {
    const value = hour[field];
    if (value === null) {
      throw new IncompleteWeatherError(`window hour is missing ${field}`);
    }
    values.push(value);
  }
  return values;
}

function sum(values: readonly number[]): number {
  return settle(values.reduce((total, value) => total + value, 0));
}

export function isWetHour(precipitationMm: number): boolean {
  return precipitationMm >= WET_HOUR_MM;
}

/** Weights of the drying index; `config/rules.json` carries the same values (tested equal). */
export interface DryingIndexWeights {
  readonly windWeight: number;
  readonly windCapKmh: number;
  readonly humidityWeight: number;
  readonly sunshineWeight: number;
  readonly sunshineSecondsPerHour: number;
}

export const DRYING_INDEX_WEIGHTS: DryingIndexWeights = {
  windWeight: 0.5,
  windCapKmh: 30,
  humidityWeight: 0.3,
  sunshineWeight: 0.2,
  sunshineSecondsPerHour: 3600,
};

/**
 * Drying index D for one hour: 0.5 * min(wind km/h, 30)/30 + 0.3 * (100 - RH)/100
 * + 0.2 * sunshine seconds/3600; a wet hour scores 0. The one implementation: the rule baseline
 * (live odds) and the outcome labels both call it.
 */
export function dryingIndex(
  hour: {
    readonly precipitationMm: number;
    readonly windSpeedKmh: number;
    readonly relativeHumidityPct: number;
    readonly sunshineSeconds: number;
  },
  weights: DryingIndexWeights = DRYING_INDEX_WEIGHTS,
  wetHourMm: number = WET_HOUR_MM,
): number {
  if (hour.precipitationMm >= wetHourMm) {
    return 0;
  }
  return settle(
    (weights.windWeight * Math.min(hour.windSpeedKmh, weights.windCapKmh)) / weights.windCapKmh +
      (weights.humidityWeight * (100 - hour.relativeHumidityPct)) / 100 +
      (weights.sunshineWeight * hour.sunshineSeconds) / weights.sunshineSecondsPerHour,
  );
}

function dryingIndices(hours: readonly HourlyWeather[]): number[] {
  const precipitation = requireField(hours, "precipitationMm");
  const wind = requireField(hours, "windSpeedKmh");
  const humidity = requireField(hours, "relativeHumidityPct");
  const sunshine = requireField(hours, "sunshineSeconds");
  return hours.map((_, index) =>
    dryingIndex({
      precipitationMm: precipitation[index] ?? 0,
      windSpeedKmh: wind[index] ?? 0,
      relativeHumidityPct: humidity[index] ?? 0,
      sunshineSeconds: sunshine[index] ?? 0,
    }),
  );
}

/** One hour is a dew hour when temp - dew point <= 2 C (dew risk for laundry left out). */
export function isDewHour(
  temperatureC: number,
  dewPointC: number,
  maxSpreadC: number = DEW_MAX_SPREAD_C,
): boolean {
  return settle(temperatureC - dewPointC) <= maxSpreadC;
}

/** Number of dew hours in the window. */
export function dewHours(hours: readonly HourlyWeather[]): number {
  const temperature = requireField(hours, "temperatureC");
  const dewPoint = requireField(hours, "dewPointC");
  return temperature.filter((value, index) => isDewHour(value, dewPoint[index] ?? 0)).length;
}

// ---------------------------------------------------------------------------------------------
// Outcome labels. Each takes exactly the window's hours (use `selectWindowHours`).
// ---------------------------------------------------------------------------------------------

/**
 * Plants: ET0 - rain over the window <= 1.0 mm. If ET0 is unavailable for any window hour,
 * rain >= 2 mm, labelled `rain_only_fallback`.
 */
export function plantsOutcome(hours: readonly HourlyWeather[]): OutcomeLabel {
  const rain = sum(requireField(hours, "precipitationMm"));
  const et0Values = hours.map((hour) => hour.et0Mm);
  if (et0Values.every((value): value is number => value !== null)) {
    const et0 = sum(et0Values);
    const netDeficit = settle(et0 - rain);
    return {
      chore: "plants",
      delivered: netDeficit <= PLANTS_MAX_NET_DEFICIT_MM,
      basis: "et0_minus_rain",
      measures: { et0Mm: et0, rainMm: rain, netDeficitMm: netDeficit },
    };
  }
  return {
    chore: "plants",
    delivered: rain >= PLANTS_FALLBACK_MIN_RAIN_MM,
    basis: "rain_only_fallback",
    measures: { rainMm: rain },
  };
}

/** Line-dry today: no wet hour and the sum of D over the window >= 3.0. */
export function lineDryOutcome(hours: readonly HourlyWeather[]): OutcomeLabel {
  const wetHours = requireField(hours, "precipitationMm").filter(isWetHour).length;
  const dryingSum = sum(dryingIndices(hours));
  return {
    chore: "laundry_line",
    delivered: wetHours === 0 && dryingSum >= LINE_DRY_MIN_DRYING_SUM,
    basis: "recorded_weather",
    measures: { wetHours, dryingSum },
  };
}

/** Leave laundry out tonight: no wet hour and fewer than 3 dew hours. */
export function laundryTonightOutcome(hours: readonly HourlyWeather[]): OutcomeLabel {
  const wetHours = requireField(hours, "precipitationMm").filter(isWetHour).length;
  const dew = dewHours(hours);
  return {
    chore: "laundry_tonight",
    delivered: wetHours === 0 && dew < DEW_HOURS_LIMIT,
    basis: "recorded_weather",
    measures: { wetHours, dewHours: dew },
  };
}

/** Skip the AC: night minimum below 23 C. */
export function acOutcome(hours: readonly HourlyWeather[]): OutcomeLabel {
  const nightMin = Math.min(...requireField(hours, "temperatureC"));
  return {
    chore: "ac",
    delivered: nightMin < AC_NIGHT_MIN_LIMIT_C,
    basis: "recorded_weather",
    measures: { nightMinC: nightMin },
  };
}

/** Skip the heater: day max >= 18 C, or day max >= 15 C and sunshine >= 5 h. */
export function heaterOutcome(hours: readonly HourlyWeather[]): OutcomeLabel {
  const dayMax = Math.max(...requireField(hours, "temperatureC"));
  const sunshineSeconds = sum(requireField(hours, "sunshineSeconds"));
  const delivered =
    dayMax >= HEATER_MAX_TEMP_C ||
    (dayMax >= HEATER_SUNNY_MAX_TEMP_C && sunshineSeconds >= HEATER_SUNNY_MIN_SECONDS);
  return {
    chore: "heater",
    delivered,
    basis: "recorded_weather",
    measures: { dayMaxC: dayMax, sunshineHours: settle(sunshineSeconds / 3600) },
  };
}

/** Label a chore from recorded hours; `hours` may be longer than the window. */
export function outcomeLabel(
  chore: OutcomeChore,
  hours: readonly HourlyWeather[],
  window: TimeWindow,
): OutcomeLabel {
  const windowHours = selectWindowHours(hours, window);
  switch (chore) {
    case "plants":
      return plantsOutcome(windowHours);
    case "laundry_line":
      return lineDryOutcome(windowHours);
    case "laundry_tonight":
      return laundryTonightOutcome(windowHours);
    case "ac":
      return acOutcome(windowHours);
    case "heater":
      return heaterOutcome(windowHours);
  }
}

/**
 * AC-008.6: a do-nothing win is a lucky win when the recorded weather does not meet the
 * chore's outcome label. Computed by code, never by Gemma.
 */
export function isLuckyWin(label: OutcomeLabel): boolean {
  return !label.delivered;
}
