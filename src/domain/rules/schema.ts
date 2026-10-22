import { z } from "zod";

const bandSchema = z.number().int().min(0).max(4);

const plantsRowSchema = z
  .object({
    rainMmAtLeast: z.number().optional(),
    maxTempCBelow: z.number().optional(),
    anyOf: z
      .object({
        rainMmAtLeast: z.number().optional(),
        maxHourlyProbabilityPctAtLeast: z.number().optional(),
      })
      .strict()
      .optional(),
    band: bandSchema,
  })
  .strict();

const plantsSchema = z
  .object({
    window: z.string(),
    rows: z.array(plantsRowSchema).min(1),
    otherwiseBand: bandSchema,
  })
  .strict();

const dryingRowSchema = z.object({ atLeast: z.number(), band: bandSchema }).strict();

const dryingIndexSchema = z
  .object({
    windWeight: z.number(),
    windCapKmh: z.number().positive(),
    humidityWeight: z.number(),
    sunshineWeight: z.number(),
    sunshineSecondsPerHour: z.number().positive(),
  })
  .strict();

const lineDrySchema = z
  .object({
    window: z.string(),
    anyWetHourBand: bandSchema,
    meanDryingIndexRows: z.array(dryingRowSchema).min(1),
    otherwiseBand: bandSchema,
  })
  .strict();

const laundryTonightSchema = z
  .object({
    window: z.string(),
    anyWetHourBand: bandSchema,
    dew: z
      .object({
        tempMinusDewPointCAtMost: z.number(),
        hoursAtLeast: z.number().int().positive(),
        band: bandSchema,
      })
      .strict(),
    meanDryingIndexRows: z.array(dryingRowSchema).min(1),
    otherwiseBand: bandSchema,
  })
  .strict();

const acSchema = z
  .object({
    window: z.string(),
    nightMinCRows: z.array(z.object({ below: z.number(), band: bandSchema }).strict()).min(1),
    otherwiseBand: bandSchema,
    windLift: z
      .object({
        meanWindKmhAtLeast: z.number(),
        bands: z.number().int().positive(),
        maxBand: bandSchema,
      })
      .strict(),
  })
  .strict();

const heaterSchema = z
  .object({
    window: z.string(),
    rows: z
      .array(
        z
          .object({
            dayMaxCAtLeast: z.number(),
            sunshineHoursAtLeast: z.number().optional(),
            band: bandSchema,
          })
          .strict(),
      )
      .min(1),
    otherwiseBand: bandSchema,
  })
  .strict();

const safetyBackstopSchema = z
  .object({
    heatMaxCAtLeast: z.number(),
    frostMinCAtMost: z.number(),
    stormGustKmhAtLeast: z.number(),
    stormWmoCodes: z.array(z.number().int()).min(1),
  })
  .strict();

/**
 * `config/rules.json` as the code reads it (design.md, Rule baseline and safety backstop). The
 * file is final for this version, so there is nothing to tune; the schema is strict so a typo in
 * a key can never silently turn a threshold off.
 */
export const rulesConfigSchema = z
  .object({
    _comment: z.string().optional(),
    version: z.number().int(),
    timeZone: z.literal("Europe/Madrid"),
    bandNames: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]),
    bandOdds: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]),
    wetHourMm: z.number(),
    dryingIndex: dryingIndexSchema,
    chores: z
      .object({
        plants: plantsSchema,
        lineDry: lineDrySchema,
        laundryTonight: laundryTonightSchema,
        ac: acSchema,
        heater: heaterSchema,
      })
      .strict(),
    safetyBackstop: safetyBackstopSchema,
  })
  .strict();

export type RulesConfig = z.infer<typeof rulesConfigSchema>;
export type PlantsRow = z.infer<typeof plantsRowSchema>;
export type DryingRow = z.infer<typeof dryingRowSchema>;
export type HeaterRow = RulesConfig["chores"]["heater"]["rows"][number];
export type SafetyBackstopConfig = z.infer<typeof safetyBackstopSchema>;

export function parseRulesConfig(raw: unknown): RulesConfig {
  const result = rulesConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid rules config: ${result.error.message}`);
  }
  return result.data;
}
