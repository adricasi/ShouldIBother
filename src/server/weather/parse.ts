import { z } from "zod";

import { HOUR_MS, madridDateOf } from "../../domain/time.js";
import { SUM_VARIABLE_NAMES, SUM_VARIABLE_STAMP, type HourStamp } from "../../domain/open-meteo.js";
import type { HourlyWeather } from "../../domain/outcomes.js";
import type { ForecastHour } from "../../domain/weather.js";

import { DAILY_VARIABLES, HOURLY_VARIABLES, type HourlyField } from "./open-meteo.js";

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

const dailySchema = z.object({
  daily: z
    .object({
      time: z.array(z.number().int()),
      [DAILY_VARIABLES.sunset]: z.array(z.number().nullable()).optional(),
    })
    .optional(),
});

/** The sunset of each Madrid date, and the dates whose sunset came from the daylight fallback. */
export interface ParsedSunsets {
  readonly sunsets: Readonly<Record<string, number>>;
  readonly fallbackDates: readonly string[];
}

/**
 * The sunset of each Madrid date as epoch milliseconds (laundry tonight's window starts there).
 * Taken from the daily `sunset` column when the answer has one; for a date it lacks, the START of
 * that date's last daylight hour (`is_day`), so the hour that contains the sunset is inside the
 * window (design.md, Outcome labels), at most an hour early. A date whose daylight is not fully in
 * the answer (the first or last day of a range) gets none. Never throws: a missing sunset only
 * means laundry tonight cannot be offered.
 */
export function parseSunsets(body: unknown, hours: readonly ForecastHour[]): ParsedSunsets {
  const sunsets: Record<string, number> = {};
  const parsed = dailySchema.safeParse(body);
  const daily = parsed.success ? parsed.data.daily : undefined;
  const column = daily?.[DAILY_VARIABLES.sunset];
  if (daily !== undefined && column !== undefined && column.length === daily.time.length) {
    daily.time.forEach((daySeconds, index) => {
      const sunsetSeconds = column[index];
      if (sunsetSeconds !== null && sunsetSeconds !== undefined) {
        sunsets[madridDateOf(daySeconds * 1000)] = sunsetSeconds * 1000;
      }
    });
  }
  const lastDaylight = new Map<string, number>();
  for (const hour of hours) {
    if (hour.isDay === true) {
      const date = madridDateOf(hour.startsAt);
      lastDaylight.set(date, Math.max(lastDaylight.get(date) ?? 0, hour.startsAt));
    }
  }
  const darkDates = new Set(
    hours
      .filter(
        (hour) =>
          hour.isDay === false &&
          hour.startsAt > (lastDaylight.get(madridDateOf(hour.startsAt)) ?? Infinity),
      )
      .map((hour) => madridDateOf(hour.startsAt)),
  );
  const fallbackDates: string[] = [];
  for (const [date, startsAt] of lastDaylight) {
    if (sunsets[date] === undefined && darkDates.has(date)) {
      sunsets[date] = startsAt;
      fallbackDates.push(date);
    }
  }
  return { sunsets, fallbackDates };
}
