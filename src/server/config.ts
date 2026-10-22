import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** Default app port (design.md, A-13). Overridden with SIB_PORT. */
export const DEFAULT_PORT = 8787;

export const CONFIG_DIR = fileURLToPath(new URL("../../config/", import.meta.url));

/** Read and parse a JSON config file; failures name the file instead of leaking a bare errno. */
export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config file ${path}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${path}: ${String(error)}`, { cause: error });
  }
}

/** The household baseline behind the savings figures (A-6). */
const householdSchema = z.object({
  airConditioning: z.boolean(),
  heaterThisSeason: z.boolean(),
  dryer: z.enum(["heat-pump", "condenser", "vented", "none"]),
});
export type Household = z.infer<typeof householdSchema>;

/**
 * `config/household.json` holds the real household values and is git-ignored (NFR-002); the
 * committed `household.example.json` is the fallback so a fresh clone still starts.
 */
export function loadHousehold(configDir: string = CONFIG_DIR): Household {
  const real = `${configDir}household.json`;
  const path = existsSync(real) ? real : `${configDir}household.example.json`;
  const result = householdSchema.safeParse(readJsonFile(path));
  if (!result.success) {
    throw new Error(`Invalid household config ${path}: ${result.error.message}`);
  }
  return result.data;
}
