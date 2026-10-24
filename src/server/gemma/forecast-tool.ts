import { z } from "zod";

import { madridParts } from "../../domain/time.js";
import type { ForecastHour } from "../../domain/weather.js";
import { MAX_TOOL_RESULT_HOURS } from "../ledger/decisions.js";
import type { ToolDefinition } from "../model/client.js";

import { JobToolArgumentError, JobToolError, type JobTool } from "./runner.js";

export const MAX_HOURS_AHEAD = 48;
/** The advisor (REQ-031) looks three days ahead; no other job may ask for more than 48 hours. */
export const ADVISOR_MAX_HOURS_AHEAD = 72;

/** The tool definition for a job that may ask for up to `maxHoursAhead` hours. */
function forecastDefinition(maxHoursAhead: number): ToolDefinition {
  return {
    name: "get_forecast",
    description:
      "Hourly weather forecast for the household's location, starting with the current hour. " +
      "Returns precipitation (mm and probability), temperature, dew point, humidity, wind and " +
      "gusts, sunshine and the WMO weather code for each hour, in Europe/Madrid time.",
    parameters: {
      type: "object",
      properties: {
        hours_ahead: {
          type: "integer",
          minimum: 1,
          maximum: maxHoursAhead,
          description: `How many hours of forecast to return, from 1 to ${maxHoursAhead}.`,
        },
      },
      required: ["hours_ahead"],
      additionalProperties: false,
    },
  };
}

/** The one tool Gemma has (design.md, Interfaces): read-only, location fixed by config. */
export const GET_FORECAST: ToolDefinition = forecastDefinition(MAX_HOURS_AHEAD);

/** The forecast hours from the current hour on, at most `hoursAhead` of them. */
export type ForecastReader = (hoursAhead: number) => Promise<readonly ForecastHour[]>;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Rounds a value; a value the forecast does not have stays `null` (unknown, never zero). */
function round(value: number | null, digits = 1): number | null {
  if (value === null) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Compact forecast rows with local times; a value the forecast lacks is an explicit `null`. */
export function forecastRows(hours: readonly ForecastHour[]) {
  return hours.map((hour) => {
    const t = madridParts(hour.startsAt);
    return {
      time: `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:00`,
      precip_mm: round(hour.precipitationMm),
      precip_prob_pct: round(hour.precipitationProbabilityPct, 0),
      temp_c: round(hour.temperatureC),
      dew_point_c: round(hour.dewPointC),
      humidity_pct: round(hour.relativeHumidityPct, 0),
      wind_kmh: round(hour.windKmh, 0),
      gust_kmh: round(hour.gustKmh, 0),
      sunshine_min: round(hour.sunshineSeconds === null ? null : hour.sunshineSeconds / 60, 0),
      weather_code: hour.weatherCode,
    };
  });
}

/** One tool result as Gemma reads it: the rows inside the data delimiters. */
export function formatForecast(hours: readonly ForecastHour[]): string {
  const rows = forecastRows(hours);
  return `<untrusted_data>\n${JSON.stringify({ timezone: "Europe/Madrid", hours: rows })}\n</untrusted_data>`;
}

/** The most hours kept with a decision (AC-028.4); the disclosure shows the first few. */
export const MAX_KEPT_HOURS = MAX_TOOL_RESULT_HOURS;

/**
 * The hours of a tool result in the few fields the "How Gemma decided" disclosure shows, as JSON
 * (migration 0016). Public weather numbers only. Undefined when the text is not a forecast.
 */
export function compactToolResult(
  resultText: string,
  keepRows: number = MAX_KEPT_HOURS,
): string | undefined {
  const found = /<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/.exec(resultText);
  if (found?.[1] === undefined) {
    return undefined;
  }
  try {
    const parsed = z
      .object({
        hours: z.array(
          z.object({
            time: z.string(),
            precip_mm: z.number().nullable(),
            precip_prob_pct: z.number().nullable(),
            temp_c: z.number().nullable(),
            wind_kmh: z.number().nullable(),
            sunshine_min: z.number().nullable(),
          }),
        ),
      })
      .parse(JSON.parse(found[1]));
    return JSON.stringify(
      parsed.hours
        .slice(0, keepRows)
        .map((hour) => [
          hour.time.slice(-5),
          hour.precip_mm,
          hour.precip_prob_pct,
          hour.temp_c,
          hour.wind_kmh,
          hour.sunshine_min,
        ]),
    );
  } catch {
    return undefined;
  }
}

export interface ForecastToolOptions {
  /** Tool use is enforced for the bookmaker (AC-003.6). */
  readonly required: boolean;
  /** Hours of the app-made call in injected mode. */
  readonly injectedHoursAhead: number;
  /**
   * The most hours a call may ask for: 48 unless the job needs more (the advisor, 72). The bound
   * is per job, so the bookmaker keeps its own.
   */
  readonly maxHoursAhead?: number;
  /** Rows of the result a decision keeps for the disclosure (24 unless the job looks further). */
  readonly keepRows?: number;
}

/**
 * `get_forecast(hours_ahead 1..48)` (1..72 for the advisor) on top of a reader of the forecast the
 * app already holds. A bad argument is answered with a message so the model can correct itself;
 * it counts as a call.
 */
export function createForecastTool(read: ForecastReader, options: ForecastToolOptions): JobTool {
  const maxHoursAhead = options.maxHoursAhead ?? MAX_HOURS_AHEAD;
  const keepRows = options.keepRows ?? MAX_KEPT_HOURS;
  const injectedHoursAhead = Math.min(Math.max(options.injectedHoursAhead, 1), maxHoursAhead);
  const argumentsSchema = z.object({
    hours_ahead: z.coerce.number().int().min(1).max(maxHoursAhead),
  });
  return {
    definition:
      maxHoursAhead === MAX_HOURS_AHEAD ? GET_FORECAST : forecastDefinition(maxHoursAhead),
    required: options.required,
    injectedArguments: { hours_ahead: injectedHoursAhead },
    summarize: (text) => compactToolResult(text, keepRows),
    keptRows: keepRows,
    async execute(args) {
      const parsed = argumentsSchema.safeParse(args);
      if (!parsed.success) {
        throw new JobToolArgumentError(
          `Invalid arguments: hours_ahead must be a whole number from 1 to ${maxHoursAhead}.`,
        );
      }
      let hours: readonly ForecastHour[];
      try {
        hours = await read(parsed.data.hours_ahead);
      } catch (error) {
        throw new JobToolError("The forecast is not available", { cause: error });
      }
      return formatForecast(hours);
    },
  };
}
