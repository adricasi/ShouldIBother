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

/**
 * The part of `config/rules.json` that the code reads (design.md, Rule baseline). Chores whose
 * rules a later task implements stay `unknown` here and are checked when that task adds them; the
 * file is final for this version, so there is nothing to tune.
 */
export const rulesConfigSchema = z
  .object({
    version: z.number().int(),
    timeZone: z.literal("Europe/Madrid"),
    bandNames: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]),
    bandOdds: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]),
    wetHourMm: z.number(),
    chores: z.object({ plants: plantsSchema }).catchall(z.unknown()),
  })
  .catchall(z.unknown());

export type RulesConfig = z.infer<typeof rulesConfigSchema>;
export type PlantsRow = z.infer<typeof plantsRowSchema>;

export function parseRulesConfig(raw: unknown): RulesConfig {
  const result = rulesConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid rules config: ${result.error.message}`);
  }
  return result.data;
}
