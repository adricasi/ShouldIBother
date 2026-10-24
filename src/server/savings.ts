import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { RAIN_CHORES } from "../domain/outcomes.js";

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
  })
  .strict()
  // Hanging laundry instead of the dryer replaces a step: time counts skipped steps only (AC-011.4).
  .refine((catalogue) => Object.values(catalogue.laundry_line).every((f) => f.time_min === 0), {
    message: "line-dry saves electricity only: time_min must be 0 (AC-011.4)",
    path: ["laundry_line"],
  });

export const DEFAULT_SAVINGS_PATH = `${CONFIG_DIR}savings.json`;
/** The city rain figures (REQ-030), apart from `savings.json` so the backtest's hash never moves. */
export const RAIN_SAVINGS_FILE = "savings-rain.json";

const rainCatalogueSchema = z
  .object({
    _comment: z.string().optional(),
    ...(Object.fromEntries(RAIN_CHORES.map((chore) => [chore, figureSchema])) as Record<
      (typeof RAIN_CHORES)[number],
      typeof figureSchema
    >),
  })
  .strict();

/** Loads `config/savings.json`: the savings of one won bet per chore (REQ-011, design.md). */
export function loadSavings(path?: string): SavingsCatalogue {
  const base = loadBaseSavings(path ?? DEFAULT_SAVINGS_PATH);
  if (path !== undefined) {
    return base;
  }
  // The app (no path) also gets the city rain figures; the backtest passes its path and does not.
  const rainPath = join(dirname(DEFAULT_SAVINGS_PATH), RAIN_SAVINGS_FILE);
  if (!existsSync(rainPath)) {
    return base;
  }
  const rain = rainCatalogueSchema.safeParse(readJsonFile(rainPath));
  if (!rain.success) {
    throw new Error(`Invalid savings config ${rainPath}: ${rain.error.message}`);
  }
  const { car_rinse, bike_rinse, terrace_rinse, rain_fill } = rain.data;
  return { ...base, rain: { car_rinse, bike_rinse, terrace_rinse, rain_fill } };
}

function loadBaseSavings(path: string): SavingsCatalogue {
  const result = catalogueSchema.safeParse(readJsonFile(path));
  if (!result.success) {
    throw new Error(`Invalid savings config ${path}: ${result.error.message}`);
  }
  const { plants, laundry_line, laundry_tonight, ac, heater } = result.data;
  return { plants, laundry_line, laundry_tonight, ac, heater };
}
