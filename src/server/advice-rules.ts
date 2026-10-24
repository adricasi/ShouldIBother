import { z } from "zod";

import type { AdviceRules } from "../domain/advice.js";

import { CONFIG_DIR, readJsonFile } from "./config.js";

export const DEFAULT_ADVICE_RULES_PATH = `${CONFIG_DIR}advice-rules.json`;

const hours = z.number().int().min(1).max(72);
const positive = z.number().positive();

const adviceRulesSchema = z
  .object({
    _comment: z.string().optional(),
    version: z.literal(1),
    wetHourMm: positive,
    nowHours: hours,
    windowsClean: z
      .object({ lookaheadHours: hours, settleHours: hours, waitWindowHours: hours })
      .strict(),
    balconySweep: z
      .object({
        gustKmhAtLeast: positive,
        lookaheadHours: hours,
        settleHours: hours,
        waitWindowHours: hours,
      })
      .strict(),
    outdoorPaint: z
      .object({
        runHours: hours,
        humidityPctBelow: z.number().min(1).max(100),
        tempCAtLeast: z.number().min(-30).max(50),
      })
      .strict(),
    lawnFeed: z
      .object({ spellMmAtLeast: positive, lookaheadHours: hours, waitWindowHours: hours })
      .strict(),
  })
  .strict();

/** Parses untrusted rule data: an unknown key or a number out of range is an error. */
export function parseAdviceRules(raw: unknown): AdviceRules {
  const result = adviceRulesSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid advice rules: ${result.error.message}`);
  }
  const { wetHourMm, nowHours, windowsClean, balconySweep, outdoorPaint, lawnFeed } = result.data;
  return { wetHourMm, nowHours, windowsClean, balconySweep, outdoorPaint, lawnFeed };
}

/** Loads `config/advice-rules.json`, the final thresholds of the advice cards (design.md). */
export function loadAdviceRules(path: string = DEFAULT_ADVICE_RULES_PATH): AdviceRules {
  return parseAdviceRules(readJsonFile(path));
}
