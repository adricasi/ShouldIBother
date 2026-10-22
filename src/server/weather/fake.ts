import { windowHourStarts, type HourlyWeather } from "../../domain/outcomes.js";
import { HOUR_MS, madridParts } from "../../domain/time.js";
import type { ForecastHour } from "../../domain/weather.js";

import type { Forecast, RecordedWeather, WeatherClient } from "./client.js";
import { WeatherUnavailableError } from "./client.js";

/** A synthetic day: constant conditions with an optional rainy spell. */
export interface FakeWeatherProfile {
  readonly temperatureC: number;
  /** Rain starting this many hours after the first forecast hour, if any. */
  readonly rain?: {
    readonly startsAfterHours: number;
    readonly hours: number;
    readonly mmPerHour: number;
  };
  /** Chance of rain shown in every hour outside the rainy spell. */
  readonly dryProbabilityPct?: number;
  /** Wind in km/h in every dry hour (10 when absent). */
  readonly windKmh?: number;
  /** Relative humidity in % in every dry hour (50 when absent). */
  readonly relativeHumidityPct?: number;
  /** Sunshine seconds in every dry daylight hour (1800 when absent). */
  readonly sunshineSeconds?: number;
  /** Gusts in km/h (20 when absent). */
  readonly gustKmh?: number;
  /** WMO weather code of dry hours (1 when absent). */
  readonly weatherCode?: number;
  /** Temperature minus dew point in °C (8 when absent). */
  readonly dewSpreadC?: number;
}

/** Named profiles for tests and for `npm run dev` before the live Open-Meteo client is wired. */
export const FAKE_WEATHER_PROFILES = {
  /** Warm and dry: the rule says "very unlikely". */
  hot: { temperatureC: 31, dryProbabilityPct: 0 },
  /** Mild and dry: the rule says "unlikely". */
  mild: { temperatureC: 22, dryProbabilityPct: 5 },
  /** A showery night: 3 mm in total, "likely". */
  rainy: {
    temperatureC: 19,
    dryProbabilityPct: 20,
    rain: { startsAfterHours: 4, hours: 6, mmPerHour: 0.5 },
  },
  /** Windy, dry air, sunny: the line-dry rule says "very likely". */
  breezy: {
    temperatureC: 22,
    dryProbabilityPct: 0,
    windKmh: 30,
    relativeHumidityPct: 30,
    sunshineSeconds: 3600,
  },
  /** Past the heat limit (35 °C): the safety backstop says "Do it now". */
  heatwave: { temperatureC: 36, dryProbabilityPct: 0 },
  /** Past the frost limit (2 °C). */
  frost: { temperatureC: 1, dryProbabilityPct: 0 },
  /** A storm: gusts past the limit and a thunderstorm code. */
  storm: { temperatureC: 20, dryProbabilityPct: 60, gustKmh: 80, weatherCode: 95 },
} as const satisfies Record<string, FakeWeatherProfile>;

export type FakeWeatherProfileName = keyof typeof FAKE_WEATHER_PROFILES;

/** Daylight in the synthetic day: 07:00 to 20:00 Madrid time (the app never reads this as a sunset). */
function isDaylight(startsAt: number): boolean {
  const { hour } = madridParts(startsAt);
  return hour >= 7 && hour < 20;
}

export function fakeForecastHours(
  profile: FakeWeatherProfile,
  fromMs: number,
  hours: number,
): ForecastHour[] {
  const first = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  return Array.from({ length: hours }, (_unused, index) => {
    const rain = profile.rain;
    const raining =
      rain !== undefined &&
      index >= rain.startsAfterHours &&
      index < rain.startsAfterHours + rain.hours;
    const startsAt = first + index * HOUR_MS;
    const daylight = isDaylight(startsAt);
    return {
      startsAt,
      precipitationMm: raining ? rain.mmPerHour : 0,
      precipitationProbabilityPct: raining ? 80 : (profile.dryProbabilityPct ?? 0),
      temperatureC: profile.temperatureC,
      dewPointC: profile.temperatureC - (profile.dewSpreadC ?? 8),
      relativeHumidityPct: raining ? 85 : (profile.relativeHumidityPct ?? 50),
      windKmh: profile.windKmh ?? 10,
      gustKmh: profile.gustKmh ?? 20,
      sunshineSeconds: raining || !daylight ? 0 : (profile.sunshineSeconds ?? 1800),
      weatherCode: raining ? 61 : (profile.weatherCode ?? 1),
      isDay: daylight,
    };
  });
}

/** The same synthetic hours as recorded weather (nullable fields, ET0 given). */
export function fakeRecordedHours(
  profile: FakeWeatherProfile,
  fromMs: number,
  hours: number,
): HourlyWeather[] {
  return fakeForecastHours(profile, fromMs, hours).map((hour) => ({
    timeMs: hour.startsAt,
    temperatureC: hour.temperatureC,
    dewPointC: hour.dewPointC,
    relativeHumidityPct: hour.relativeHumidityPct,
    precipitationMm: hour.precipitationMm,
    precipitationProbabilityPct: hour.precipitationProbabilityPct,
    windSpeedKmh: hour.windKmh,
    windGustsKmh: hour.gustKmh,
    weatherCode: hour.weatherCode,
    sunshineSeconds: hour.sunshineSeconds,
    et0Mm: 0.1,
  }));
}

/** Deterministic weather without a network; `failWith` simulates Open-Meteo being down. */
export class FakeWeatherClient implements WeatherClient {
  readonly requests: { fromMs: number; hours: number }[] = [];
  readonly recordedRequests: { fromMs: number; toMs: number }[] = [];
  failWith: Error | undefined;
  /** False: recorded weather is not there yet, so a settlement keeps waiting (AC-014.5). */
  recordedAvailable = true;
  private lastFetchedAt: number | undefined;

  constructor(
    private readonly now: () => number,
    private profile: FakeWeatherProfile = FAKE_WEATHER_PROFILES.mild,
  ) {}

  setProfile(profile: FakeWeatherProfile): void {
    this.profile = profile;
  }

  latestForecastFetchedAt(): number | undefined {
    return this.lastFetchedAt;
  }

  getForecast(request: { fromMs: number; hours: number }): Promise<Forecast> {
    this.requests.push({ ...request });
    if (this.failWith !== undefined) {
      return Promise.reject(new WeatherUnavailableError(this.failWith.message));
    }
    this.lastFetchedAt = this.now();
    return Promise.resolve({
      fetchedAt: this.lastFetchedAt,
      hours: fakeForecastHours(this.profile, request.fromMs, request.hours),
    });
  }

  getRecorded(request: { fromMs: number; toMs: number }): Promise<RecordedWeather> {
    this.recordedRequests.push({ ...request });
    if (this.failWith !== undefined) {
      return Promise.reject(new WeatherUnavailableError(this.failWith.message));
    }
    const starts = windowHourStarts({ startMs: request.fromMs, endMs: request.toMs });
    const first = starts[0] ?? request.fromMs;
    return Promise.resolve({
      fetchedAt: this.now(),
      complete: this.recordedAvailable,
      hours: this.recordedAvailable ? fakeRecordedHours(this.profile, first, starts.length) : [],
    });
  }
}
