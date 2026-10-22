import { parseRulesConfig, type RulesConfig } from "../domain/rules/index.js";

import { CONFIG_DIR, readJsonFile } from "./config.js";

export const DEFAULT_RULES_PATH = `${CONFIG_DIR}rules.json`;

/** Loads `config/rules.json`, the final thresholds of the rule baseline (design.md). */
export function loadRules(path: string = DEFAULT_RULES_PATH): RulesConfig {
  return parseRulesConfig(readJsonFile(path));
}
