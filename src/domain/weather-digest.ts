import { WET_HOUR_MM, type HourlyWeather } from "./outcomes.js";

/** How the app calls the weather a bet is judged on (ADR-0008): modelled, not measured. */
export const RECORDED_WEATHER_LABEL = "Modelled recent weather (Open-Meteo)";

/**
 * The numbers of a bet's window, kept short: this is what the settle screen shows, what the judge
 * reads and what "Gemma's read" lists as the weather it used (AC-008.1, AC-028.1). A value the
 * hours do not have is null, never zero.
 */
export interface WeatherDigest {
  readonly hours: number;
  readonly rain_mm: number | null;
  readonly wet_hours: number | null;
  readonly temp_min_c: number | null;
  readonly temp_max_c: number | null;
  readonly wind_max_kmh: number | null;
  readonly sunshine_h: number | null;
}

/** The weather stored with a settlement, and with the settle screen before it (AC-008.1). */
export interface WeatherSnapshot {
  readonly label: typeof RECORDED_WEATHER_LABEL;
  readonly fetched_at: number;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly digest: WeatherDigest;
  readonly hours: readonly HourlyWeather[];
}

function values(hours: readonly HourlyWeather[], pick: (hour: HourlyWeather) => number | null) {
  return hours.map(pick).filter((value): value is number => value !== null);
}

const sum = (list: readonly number[]): number | null =>
  list.length === 0 ? null : list.reduce((total, value) => total + value, 0);
const round = (value: number | null, decimals: number): number | null =>
  value === null ? null : Math.round(value * 10 ** decimals) / 10 ** decimals;

export function digestOf(hours: readonly HourlyWeather[]): WeatherDigest {
  const rain = values(hours, (hour) => hour.precipitationMm);
  const temperatures = values(hours, (hour) => hour.temperatureC);
  const winds = values(hours, (hour) => hour.windSpeedKmh);
  const sunshineSeconds = sum(values(hours, (hour) => hour.sunshineSeconds));
  return {
    hours: hours.length,
    rain_mm: round(sum(rain), 1),
    wet_hours: rain.length === 0 ? null : rain.filter((mm) => mm >= WET_HOUR_MM).length,
    temp_min_c: temperatures.length === 0 ? null : Math.min(...temperatures),
    temp_max_c: temperatures.length === 0 ? null : Math.max(...temperatures),
    wind_max_kmh: winds.length === 0 ? null : Math.max(...winds),
    sunshine_h: round(sunshineSeconds === null ? null : sunshineSeconds / 3600, 1),
  };
}

export function snapshotOf(input: {
  readonly fetchedAt: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly hours: readonly HourlyWeather[];
}): WeatherSnapshot {
  return {
    label: RECORDED_WEATHER_LABEL,
    fetched_at: input.fetchedAt,
    from_ms: input.fromMs,
    to_ms: input.toMs,
    digest: digestOf(input.hours),
    hours: input.hours,
  };
}

/** Reads a stored snapshot; null when there is none or the text is not one. */
export function parseWeatherSnapshot(text: string | null): WeatherSnapshot | null {
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as Partial<WeatherSnapshot> | null;
    if (
      value !== null &&
      typeof value === "object" &&
      Array.isArray(value.hours) &&
      typeof value.digest === "object" &&
      value.digest !== null &&
      typeof value.from_ms === "number" &&
      typeof value.to_ms === "number"
    ) {
      return value as WeatherSnapshot;
    }
  } catch {
    // unreadable text counts as no snapshot
  }
  return null;
}
