import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Feature flags (REQ-029). Every Should and Could feature has a flag that is off by default;
 * only the builder turns one on, in config/flags.json, after merging and checking the feature.
 */
export const FLAG_NAMES = [
  "finetunedBookmaker",
  "safetyGuard",
  "laundryTonight",
  "score",
  "stampAnimation",
  "laundryPlanner",
  "rescue",
  "appeals",
  "onboarding",
  "ranks",
  "heater",
  "splitFlap",
  "voice",
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];
export type Flags = Readonly<Record<FlagName, boolean>>;

const flagsSchema = z
  .object(
    Object.fromEntries(FLAG_NAMES.map((name) => [name, z.boolean().default(false)])) as Record<
      FlagName,
      z.ZodDefault<z.ZodBoolean>
    >,
  )
  .strict();

export const DEFAULT_FLAGS_PATH = fileURLToPath(
  new URL("../../config/flags.json", import.meta.url),
);

/** Parse untrusted flag data: unknown names and non-boolean values are errors, missing flags are off. */
export function parseFlags(raw: unknown): Flags {
  const result = flagsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid feature flags: ${result.error.message}`);
  }
  return result.data;
}

export function loadFlags(path: string = DEFAULT_FLAGS_PATH): Flags {
  return parseFlags(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
