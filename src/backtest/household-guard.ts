/**
 * The household guard of the fine-tune dataset (AC-019.8, NFR-002): the rows are public-weather
 * plus a synthetic habit profile, and may be uploaded (Colab, Hugging Face). If any value from
 * `config/household.json` appears in a row, the build fails.
 *
 * What counts as "a value": every string of three or more characters (whole words, ignoring case)
 * and every number with decimals, also rounded to 2 decimals (the coordinates). Booleans and whole
 * numbers say nothing identifying and would match everywhere, so they are not searched; the habit
 * profile is a fixed committed file, and its test checks it against the household's possible values.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HouseholdProbe {
  /** Where the value sits in household.json, e.g. `location.latitude`; never the value itself. */
  readonly path: string;
  readonly pattern: RegExp;
}

export class HouseholdLeakError extends Error {
  override readonly name = "HouseholdLeakError";
  constructor(
    /** `<row id>: <household.json path>` for every hit; no household value is ever included. */
    readonly leaks: readonly string[],
  ) {
    super(
      `Household values found in the dataset (${leaks.length}): ${leaks.slice(0, 5).join("; ")}` +
        `${leaks.length > 5 ? "; ..." : ""}. The build stops; the rows must come from the synthetic habit profile only.`,
    );
  }
}

const MIN_STRING_CHARS = 3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(value: unknown, path: string, out: HouseholdProbe[]): void {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length >= MIN_STRING_CHARS) {
      out.push({
        path,
        pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(text)}(?![\\p{L}\\p{N}])`, "iu"),
      });
    }
  } else if (typeof value === "number") {
    if (Number.isFinite(value) && !Number.isInteger(value)) {
      for (const form of new Set([String(value), value.toFixed(2)])) {
        out.push({ path, pattern: new RegExp(`(?<![\\d.])${escapeRegExp(form)}(?!\\d)`) });
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      walk(item, `${path}[${index}]`, out);
    });
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      walk(item, path === "" ? key : `${path}.${key}`, out);
    }
  }
}

/** The searchable values of a parsed household config. */
export function householdProbes(household: unknown): HouseholdProbe[] {
  const probes: HouseholdProbe[] = [];
  walk(household, "", probes);
  return probes;
}

/**
 * Reads `household.json` (the real one when it exists) and the committed example next to it: a
 * value of either must stay out of the rows. A missing or unreadable file is an error, not "no
 * values to check".
 */
export function loadHouseholdProbes(configDir: string): HouseholdProbe[] {
  const probes: HouseholdProbe[] = [];
  let found = 0;
  for (const name of ["household.json", "household.example.json"]) {
    const path = join(configDir, name);
    if (!existsSync(path)) {
      continue;
    }
    found += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Cannot read ${path} for the household check: ${String(error)}`, {
        cause: error,
      });
    }
    // Keys that start with "_" are comments, not values.
    const values = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([key]) => !key.startsWith("_")),
    );
    probes.push(
      ...householdProbes(values).map((probe) => ({ ...probe, path: `${name}:${probe.path}` })),
    );
  }
  if (found === 0) {
    throw new Error(
      `No household.json or household.example.json in ${configDir} to check against.`,
    );
  }
  return probes;
}

/** Every string inside a JSON value, plus its JSON text (escapes can hide a value from either). */
function searchableTexts(value: unknown): string[] {
  const texts = [JSON.stringify(value)];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      texts.push(item);
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (typeof item === "object" && item !== null) {
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return texts;
}

/** The paths of the probes whose value appears in `value` (deduplicated, in probe order). */
export function householdHits(value: unknown, probes: readonly HouseholdProbe[]): string[] {
  const texts = searchableTexts(value);
  const hits = new Set<string>();
  for (const probe of probes) {
    if (texts.some((text) => probe.pattern.test(text))) {
      hits.add(probe.path);
    }
  }
  return [...hits];
}

/** Fails the build (AC-019.8) if a household value appears in any item. */
export function assertNoHouseholdValues(
  items: readonly { readonly id: string; readonly value: unknown }[],
  probes: readonly HouseholdProbe[],
): void {
  const leaks = items.flatMap((item) =>
    householdHits(item.value, probes).map((path) => `${item.id}: ${path}`),
  );
  if (leaks.length > 0) {
    throw new HouseholdLeakError(leaks);
  }
}
