import { z } from "zod";

import { DRYER_TYPES, FIGURE_BASES, type SavingsCatalogue } from "../domain/savings.js";

import { CONFIG_DIR, readJsonFile } from "./config.js";

const figureSchema = z
  .object({
    time_min: z.number().min(0),
    water_l: z.number().min(0),
    electricity_kwh: z.number().min(0),
    assumption: z.string().min(1),
    basis: z.enum(FIGURE_BASES),
    source: z.url().optional(),
  })
  .strict()
  .refine((figure) => figure.basis !== "sourced" || figure.source !== undefined, {
    message: 'a "sourced" figure needs a source link',
  });

const catalogueSchema = z
  .object({
    _comment: z.string().optional(),
    plants: figureSchema,
    laundry_line: z.object(
      Object.fromEntries(DRYER_TYPES.map((dryer) => [dryer, figureSchema])) as Record<
        (typeof DRYER_TYPES)[number],
        typeof figureSchema
      >,
    ),
    laundry_tonight: figureSchema,
    ac: figureSchema,
    heater: figureSchema,
    // The city rain bets (REQ-030); optional so the backtest's older copies of the file still load.
    car_rinse: figureSchema.optional(),
    bike_rinse: figureSchema.optional(),
    terrace_rinse: figureSchema.optional(),
    rain_fill: figureSchema.optional(),
  })
  .strict()
  // Hanging laundry instead of the dryer replaces a step: time counts skipped steps only (AC-011.4).
  .refine((catalogue) => Object.values(catalogue.laundry_line).every((f) => f.time_min === 0), {
    message: "line-dry saves electricity only: time_min must be 0 (AC-011.4)",
    path: ["laundry_line"],
  });

export const DEFAULT_SAVINGS_PATH = `${CONFIG_DIR}savings.json`;

/**
 * Loads `config/savings.json`: the savings of one won bet per chore (REQ-011, design.md). Called
 * with no path (the app) it also returns the city rain figures (REQ-030) under `rain`; given a
 * path (the backtest) it returns the five REQ-016 chores alone, so the catalogue the backtest
 * report hashes stays as it was (AC-030.3).
 */
export function loadSavings(path?: string): SavingsCatalogue {
  const file = path ?? DEFAULT_SAVINGS_PATH;
  const result = catalogueSchema.safeParse(readJsonFile(file));
  if (!result.success) {
    throw new Error(`Invalid savings config ${file}: ${result.error.message}`);
  }
  const { plants, laundry_line, laundry_tonight, ac, heater, car_rinse, bike_rinse } = result.data;
  const { terrace_rinse, rain_fill } = result.data;
  const base = { plants, laundry_line, laundry_tonight, ac, heater };
  if (path !== undefined || !car_rinse || !bike_rinse || !terrace_rinse || !rain_fill) {
    return base;
  }
  return { ...base, rain: { car_rinse, bike_rinse, terrace_rinse, rain_fill } };
}
