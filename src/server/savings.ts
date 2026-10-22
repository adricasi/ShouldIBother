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
  })
  .strict()
  // Hanging laundry instead of the dryer replaces a step: time counts skipped steps only (AC-011.4).
  .refine((catalogue) => Object.values(catalogue.laundry_line).every((f) => f.time_min === 0), {
    message: "line-dry saves electricity only: time_min must be 0 (AC-011.4)",
    path: ["laundry_line"],
  });

export const DEFAULT_SAVINGS_PATH = `${CONFIG_DIR}savings.json`;

/** Loads `config/savings.json`: the savings of one won bet per chore (REQ-011, design.md). */
export function loadSavings(path: string = DEFAULT_SAVINGS_PATH): SavingsCatalogue {
  const result = catalogueSchema.safeParse(readJsonFile(path));
  if (!result.success) {
    throw new Error(`Invalid savings config ${path}: ${result.error.message}`);
  }
  const { plants, laundry_line, laundry_tonight, ac, heater } = result.data;
  return { plants, laundry_line, laundry_tonight, ac, heater };
}
