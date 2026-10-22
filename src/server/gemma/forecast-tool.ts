import { z } from "zod";

import { madridParts } from "../../domain/time.js";
import type { ForecastHour } from "../../domain/weather.js";
import type { ToolDefinition } from "../model/client.js";

import { JobToolArgumentError, JobToolError, type JobTool } from "./runner.js";

export const MAX_HOURS_AHEAD = 48;

/** The one tool Gemma has (design.md, Interfaces): read-only, location fixed by config. */
export const GET_FORECAST: ToolDefinition = {
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
        maximum: MAX_HOURS_AHEAD,
        description: `How many hours of forecast to return, from 1 to ${MAX_HOURS_AHEAD}.`,
      },
    },
    required: ["hours_ahead"],
    additionalProperties: false,
  },
};

const argumentsSchema = z.object({
  hours_ahead: z.coerce.number().int().min(1).max(MAX_HOURS_AHEAD),
});

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

/**
 * One tool result as Gemma reads it: compact rows, local times, inside the data delimiters. A value
 * the forecast lacks is an explicit `null`, which the prompt says means unknown.
 */
export function formatForecast(hours: readonly ForecastHour[]): string {
  const rows = hours.map((hour) => {
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
  return `<untrusted_data>\n${JSON.stringify({ timezone: "Europe/Madrid", hours: rows })}\n</untrusted_data>`;
}

export interface ForecastToolOptions {
  /** Tool use is enforced for the bookmaker (AC-003.6). */
  readonly required: boolean;
  /** Hours of the app-made call in injected mode. */
  readonly injectedHoursAhead: number;
}

/**
 * `get_forecast(hours_ahead 1..48)` on top of a reader of the forecast the app already holds. A
 * bad argument is answered with a message so the model can correct itself; it counts as a call.
 */
export function createForecastTool(read: ForecastReader, options: ForecastToolOptions): JobTool {
  const injectedHoursAhead = Math.min(Math.max(options.injectedHoursAhead, 1), MAX_HOURS_AHEAD);
  return {
    definition: GET_FORECAST,
    required: options.required,
    injectedArguments: { hours_ahead: injectedHoursAhead },
    async execute(args) {
      const parsed = argumentsSchema.safeParse(args);
      if (!parsed.success) {
        throw new JobToolArgumentError(
          `Invalid arguments: hours_ahead must be a whole number from 1 to ${MAX_HOURS_AHEAD}.`,
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
