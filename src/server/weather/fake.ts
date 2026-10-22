import { HOUR_MS, type ForecastHour } from "../../domain/weather.js";

import type { Forecast, WeatherClient } from "./client.js";
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
}

/** Named profiles for tests and for `npm run dev` before the real Open-Meteo client (T-005). */
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
} as const satisfies Record<string, FakeWeatherProfile>;

export type FakeWeatherProfileName = keyof typeof FAKE_WEATHER_PROFILES;

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
    return {
      startsAt: first + index * HOUR_MS,
      precipitationMm: raining ? rain.mmPerHour : 0,
      precipitationProbabilityPct: raining ? 80 : (profile.dryProbabilityPct ?? 0),
      temperatureC: profile.temperatureC,
      dewPointC: profile.temperatureC - 8,
      relativeHumidityPct: raining ? 85 : 50,
      windKmh: 10,
      gustKmh: 20,
      sunshineSeconds: raining ? 0 : 1800,
      weatherCode: raining ? 61 : 1,
    };
  });
}

/** Deterministic forecasts without a network; `failWith` simulates Open-Meteo being down. */
export class FakeWeatherClient implements WeatherClient {
  readonly requests: { fromMs: number; hours: number }[] = [];
  failWith: Error | undefined;

  constructor(
    private readonly now: () => number,
    private profile: FakeWeatherProfile = FAKE_WEATHER_PROFILES.mild,
  ) {}

  setProfile(profile: FakeWeatherProfile): void {
    this.profile = profile;
  }

  getForecast(request: { fromMs: number; hours: number }): Promise<Forecast> {
    this.requests.push({ ...request });
    if (this.failWith !== undefined) {
      return Promise.reject(new WeatherUnavailableError(this.failWith.message));
    }
    return Promise.resolve({
      fetchedAt: this.now(),
      hours: fakeForecastHours(this.profile, request.fromMs, request.hours),
    });
  }
}
