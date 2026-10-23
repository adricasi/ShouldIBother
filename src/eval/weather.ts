import { z } from "zod";

import type { HourlyWeather } from "../domain/outcomes.js";
import { HOUR_MS, type ForecastHour } from "../domain/weather.js";
import {
  FAKE_WEATHER_PROFILES,
  fakeForecastHours,
  fakeSunsets,
  type FakeWeatherProfile,
} from "../server/weather/fake.js";

/**
 * Synthetic weather for the eval cases (`evals/<job>/cases.json`). A case names one of the fake
 * weather profiles, or lists segments of hours, each with its own profile, so a planner case can
 * have a wet Tuesday and a dry Thursday. Nothing here is real: the eval never calls Open-Meteo.
 */

const profileFields = {
  temperatureC: z.number().min(-30).max(55),
  rain: z
    .object({
      startsAfterHours: z.number().int().min(0),
      hours: z.number().int().min(1),
      mmPerHour: z.number().min(0),
    })
    .strict()
    .optional(),
  dryProbabilityPct: z.number().min(0).max(100).optional(),
  windKmh: z.number().min(0).optional(),
  relativeHumidityPct: z.number().min(0).max(100).optional(),
  sunshineSeconds: z.number().min(0).max(3600).optional(),
  gustKmh: z.number().min(0).optional(),
  weatherCode: z.number().int().min(0).max(99).optional(),
  dewSpreadC: z.number().min(0).optional(),
};

const segmentSchema = z
  .object({
    /** How many hours the segment lasts; the last segment may leave it out and runs on. */
    hours: z.number().int().min(1).optional(),
    ...profileFields,
  })
  .strict();

type Segment = z.infer<typeof segmentSchema>;

export const PROFILE_NAMES = Object.keys(FAKE_WEATHER_PROFILES) as [
  keyof typeof FAKE_WEATHER_PROFILES,
  ...(keyof typeof FAKE_WEATHER_PROFILES)[],
];

export const weatherSpecSchema = z.union([
  z.enum(PROFILE_NAMES),
  z.array(segmentSchema).min(1).max(12),
]);

export type WeatherSpec = z.infer<typeof weatherSpecSchema>;

function profileOf(segment: Segment): FakeWeatherProfile {
  // `exactOptionalPropertyTypes`: keep only the keys the case wrote, and not the segment length.
  return Object.fromEntries(
    Object.entries(segment).filter(([key, value]) => key !== "hours" && value !== undefined),
  ) as unknown as FakeWeatherProfile;
}

function segmentsOf(
  spec: WeatherSpec,
): { profile: FakeWeatherProfile; hours: number | undefined }[] {
  if (typeof spec === "string") {
    return [{ profile: FAKE_WEATHER_PROFILES[spec], hours: undefined }];
  }
  return spec.map((segment) => ({ profile: profileOf(segment), hours: segment.hours }));
}

export interface SyntheticForecast {
  readonly hours: readonly ForecastHour[];
  readonly sunsetMsByDate: Readonly<Record<string, number>>;
}

/**
 * `pastHours` hours before the hour of `fromMs` and `hours` from it on. A segment without `hours`
 * (or the last one, when the segments are too short) runs to the end.
 */
export function syntheticForecast(
  spec: WeatherSpec,
  fromMs: number,
  hours: number,
  pastHours = 0,
): SyntheticForecast {
  const anchor = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  const segments = segmentsOf(spec);
  const result: ForecastHour[] = [];
  let used = 0;
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    const length = last
      ? Math.max(hours - used, 0)
      : Math.min(segment.hours ?? hours - used, hours - used);
    if (length > 0 || index === 0) {
      result.push(
        ...fakeForecastHours(
          segment.profile,
          anchor + used * HOUR_MS,
          length,
          index === 0 ? pastHours : 0,
        ),
      );
    }
    used += length;
  });
  return { hours: result, sunsetMsByDate: fakeSunsets(result) };
}

/** The same hours as recorded weather, for the judge's digest. */
export function syntheticRecorded(
  spec: WeatherSpec,
  fromMs: number,
  hours: number,
): HourlyWeather[] {
  return syntheticForecast(spec, fromMs, hours).hours.map((hour) => ({
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
