/**
 * The household guard of the fine-tune dataset (AC-019.8, NFR-002): the rows are public-weather
 * plus a synthetic habit profile, and may be uploaded (Colab, Hugging Face). If any value from
 * `config/household.json` appears in a row, the build fails.
 *
 * What counts as "a value": every string of three or more characters (whole words, ignoring case)
 * and every number with decimals, by its absolute value as written and rounded to 2, 3 and 4
 * decimals (and to 1 decimal from 10 up: a one-decimal longitude such as 2.2 would match any
 * rainfall figure), with `.` or `,` as the decimal separator. Booleans and whole numbers say
 * nothing identifying and would match everywhere, so they are not searched; the habit profile is a
 * fixed committed file, and its test checks it against the household's possible values.
 *
 * Only `config/household.json` is checked. The onboarding profile in the database
 * (`household_profile`) is not probed: the dataset command never opens the database.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HouseholdProbe {
  /** Where the value sits in household.json, e.g. `location.latitude`; never the value itself. */
  readonly path: string;
  readonly pattern: RegExp;
}

/** `household.json` is missing or not valid JSON; the message never carries file content. */
export class HouseholdConfigError extends Error {
  override readonly name = "HouseholdConfigError";
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
      const abs = Math.abs(value);
      const forms = new Set([String(abs), abs.toFixed(2), abs.toFixed(3), abs.toFixed(4)]);
      if (abs >= 10) {
        forms.add(abs.toFixed(1));
      }
      for (const form of forms) {
        const [whole, decimals] = form.split(".");
        if (whole !== undefined && decimals !== undefined) {
          out.push({
            path,
            pattern: new RegExp(`(?<![\\d.,])${whole}[.,]${decimals}(?!\\d)`),
          });
        }
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
    } catch {
      // No `cause` and no parser text: a JSON error quotes the file, which is household data.
      throw new HouseholdConfigError(`${path} is not valid JSON (or cannot be read).`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HouseholdConfigError(`${path} is not a JSON object.`);
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
