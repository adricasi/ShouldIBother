import { z } from "zod";

import { HOUR_MS } from "../../domain/time.js";
import { SUM_VARIABLE_NAMES, SUM_VARIABLE_STAMP, type HourStamp } from "../../domain/open-meteo.js";
import type { HourlyWeather } from "../../domain/outcomes.js";
import type { ForecastHour } from "../../domain/weather.js";

import { HOURLY_VARIABLES, type HourlyField } from "./open-meteo.js";

const column = z.array(z.number().nullable());

/** The part of an Open-Meteo answer the app reads: epoch-second times and one column per variable. */
const responseSchema = z.object({
  hourly: z.object({ time: z.array(z.number().int()) }).catchall(z.unknown()),
});

export class OpenMeteoFormatError extends Error {
  override readonly name = "OpenMeteoFormatError";
}

/** Hourly values by hour start (epoch ms): `null` is a value Open-Meteo did not provide. */
export interface HourlyTable {
  readonly hourStarts: readonly number[];
  value(field: HourlyField, hourStart: number): number | null;
}

const SUM_FIELDS = new Set<HourlyField>(
  (Object.keys(HOURLY_VARIABLES) as HourlyField[]).filter((field) =>
    (SUM_VARIABLE_NAMES as readonly string[]).includes(HOURLY_VARIABLES[field]),
  ),
);

/**
 * Parses a forecast answer. Unknown variables are ignored, a missing variable reads as all
 * null, and sum variables are moved onto the hour they cover when the API stamps them with the
 * end of the hour (`SUM_VARIABLE_STAMP`).
 */
export function parseHourlyTable(
  body: unknown,
  stamp: HourStamp = SUM_VARIABLE_STAMP,
): HourlyTable {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OpenMeteoFormatError(`unexpected Open-Meteo answer: ${parsed.error.message}`);
  }
  const { hourly } = parsed.data;
  const times = hourly.time.map((seconds) => seconds * 1000);
  const columns = new Map<HourlyField, readonly (number | null)[]>();
  for (const [field, variable] of Object.entries(HOURLY_VARIABLES) as [HourlyField, string][]) {
    const raw = hourly[variable];
    if (raw === undefined) {
      continue;
    }
    const values = column.safeParse(raw);
    if (!values.success || values.data.length !== times.length) {
      throw new OpenMeteoFormatError(`unexpected Open-Meteo column ${variable}`);
    }
    columns.set(field, values.data);
  }
  const indexByTime = new Map(times.map((time, index) => [time, index]));
  return {
    hourStarts: times,
    value(field, hourStart) {
      const source = columns.get(field);
      if (source === undefined) {
        return null;
      }
      const stampedAt =
        stamp === "hour_end" && SUM_FIELDS.has(field) ? hourStart + HOUR_MS : hourStart;
      const index = indexByTime.get(stampedAt);
      return index === undefined ? null : (source[index] ?? null);
    },
  };
}

/**
 * Every hour Open-Meteo listed, with the values it gave. An hour with a missing value is kept
 * with `null` there: the safety backstop must still see its temperature, gust and weather code,
 * and a rule that needs the missing value simply cannot price its window.
 */
export function forecastHours(table: HourlyTable): ForecastHour[] {
  return table.hourStarts
    .map((startsAt) => {
      const v = (field: HourlyField): number | null => table.value(field, startsAt);
      const day = v("isDay");
      return {
        startsAt,
        temperatureC: v("temperatureC"),
        dewPointC: v("dewPointC"),
        relativeHumidityPct: v("relativeHumidityPct"),
        precipitationMm: v("precipitationMm"),
        precipitationProbabilityPct: v("precipitationProbabilityPct"),
        windKmh: v("windKmh"),
        gustKmh: v("gustKmh"),
        weatherCode: v("weatherCode"),
        sunshineSeconds: v("sunshineSeconds"),
        isDay: day === null ? null : day === 1,
      };
    })
    .sort((a, b) => a.startsAt - b.startsAt);
}

/** Recorded hours as the outcome labels read them: a value Open-Meteo did not give stays null. */
export function recordedHours(table: HourlyTable): HourlyWeather[] {
  return table.hourStarts
    .map((timeMs) => ({
      timeMs,
      temperatureC: table.value("temperatureC", timeMs),
      dewPointC: table.value("dewPointC", timeMs),
      relativeHumidityPct: table.value("relativeHumidityPct", timeMs),
      precipitationMm: table.value("precipitationMm", timeMs),
      precipitationProbabilityPct: table.value("precipitationProbabilityPct", timeMs),
      windSpeedKmh: table.value("windKmh", timeMs),
      windGustsKmh: table.value("gustKmh", timeMs),
      weatherCode: table.value("weatherCode", timeMs),
      sunshineSeconds: table.value("sunshineSeconds", timeMs),
      et0Mm: table.value("et0Mm", timeMs),
    }))
    .sort((a, b) => a.timeMs - b.timeMs);
}

/** The values a settlement needs from every hour of the window (ET0 is optional: labelled fallback). */
export const REQUIRED_FOR_SETTLEMENT = [
  "temperatureC",
  "dewPointC",
  "relativeHumidityPct",
  "precipitationMm",
  "windSpeedKmh",
  "sunshineSeconds",
] as const satisfies readonly (keyof HourlyWeather)[];
