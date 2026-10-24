import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseRainRules, parseRulesConfig, type RulesConfig } from "../domain/rules/index.js";

import { CONFIG_DIR, readJsonFile } from "./config.js";

export const DEFAULT_RULES_PATH = `${CONFIG_DIR}rules.json`;
/** The city rain rows (REQ-030), apart from `rules.json` so that file's hash never moves. */
export const RAIN_RULES_FILE = "rules-rain.json";

/**
 * Loads `config/rules.json`, the final thresholds of the rule baseline (design.md). Called with no
 * path (the app) it also attaches the city rain rows of `config/rules-rain.json`; given a path it
 * loads that file alone, as the backtest and the dataset read it.
 */
export function loadRules(path?: string): RulesConfig {
  const rules = parseRulesConfig(readJsonFile(path ?? DEFAULT_RULES_PATH));
  if (path !== undefined) {
    return rules;
  }
  const rainPath = join(dirname(DEFAULT_RULES_PATH), RAIN_RULES_FILE);
  return existsSync(rainPath) ? { ...rules, rain: parseRainRules(readJsonFile(rainPath)) } : rules;
}
