import { z } from "zod";

import { CONFIG_DIR, readJsonFile } from "./config.js";
import { FLAG_NAMES, type FlagName } from "./flags.js";

/** Name of the preset behind `sib flags preset presentation` and `sib demo` (AC-029.3). */
export const PRESENTATION_PRESET = "presentation";

const flagNameSchema = z.enum(FLAG_NAMES);

const presetsSchema = z.record(
  z.string(),
  z.array(flagNameSchema).refine((names) => new Set(names).size === names.length, "each flag once"),
);

export type FlagPresets = Readonly<Record<string, readonly FlagName[]>>;

export const DEFAULT_PRESETS_PATH = `${CONFIG_DIR}flags.presets.json`;

/**
 * `config/flags.presets.json`: an explicit list of flag names per preset, edited by the builder.
 * Unknown flag names are an error, so a typo cannot silently drop a feature from the demo.
 */
export function loadFlagPresets(path: string = DEFAULT_PRESETS_PATH): FlagPresets {
  const result = presetsSchema.safeParse(readJsonFile(path));
  if (!result.success) {
    throw new Error(`Invalid flag presets ${path}: ${result.error.message}`);
  }
  return result.data;
}
