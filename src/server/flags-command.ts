import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { CONFIG_DIR } from "./config.js";
import { loadFlagPresets } from "./flag-presets.js";
import { FLAG_NAMES, parseFlags, type FlagName, type Flags } from "./flags.js";

type Print = (text: string) => void;

const FLAGS_USAGE =
  "Usage: sib flags [list] | on <flag>... | off <flag>... | preset <name> [flag...]";

function isFlagName(value: string): value is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(value);
}

/** Every argument must be a known flag name; the first unknown one is an error. */
function parseNames(names: readonly string[]): FlagName[] | string {
  const unknown = names.filter((name) => !isFlagName(name));
  if (unknown.length > 0) {
    return `Unknown flag: ${unknown.join(", ")}\nKnown flags: ${FLAG_NAMES.join(", ")}`;
  }
  return names.filter(isFlagName);
}

/** What the flags file holds now, keeping its key order; invalid content is an error. */
function readCurrent(path: string): { order: string[]; flags: Flags } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const flags = parseFlags(raw);
  return { order: Object.keys(raw as Record<string, unknown>), flags };
}

/** Writes the whole file to a temporary sibling and renames it over the original (atomic). */
function writeAtomically(path: string, order: readonly string[], flags: Flags): void {
  const keys = [...order, ...FLAG_NAMES.filter((name) => !order.includes(name))];
  const body = Object.fromEntries(keys.map((key) => [key, flags[key as FlagName]]));
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function describeFlags(flags: Flags): string {
  const width = Math.max(...FLAG_NAMES.map((name) => name.length));
  return FLAG_NAMES.map((name) => `${name.padEnd(width)}  ${flags[name] ? "on" : "off"}`).join(
    "\n",
  );
}

/**
 * `sib flags` (AC-029.3): lists the flags and turns them on or off in `config/flags.json`. A preset
 * from `config/flags.presets.json` turns on the flags it lists (the `presentation` preset leaves
 * `voice` and `finetunedBookmaker` out; name them to turn them on). Returns the exit code;
 * changes need an app restart.
 */
export function flagsCommand(
  args: readonly string[],
  print: Print,
  configDir: string = CONFIG_DIR,
): number {
  const [action = "list", ...rest] = args;
  const path = `${configDir}flags.json`;
  let current: { order: string[]; flags: Flags };
  try {
    current = readCurrent(path);
  } catch (error) {
    print(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const changes = new Map<FlagName, boolean>();
  switch (action) {
    case "list":
      if (rest.length > 0) {
        print(FLAGS_USAGE);
        return 1;
      }
      print(describeFlags(current.flags));
      return 0;
    case "on":
    case "off": {
      const names = parseNames(rest);
      if (typeof names === "string" || names.length === 0) {
        print(typeof names === "string" ? `${names}\n${FLAGS_USAGE}` : FLAGS_USAGE);
        return 1;
      }
      for (const name of names) {
        changes.set(name, action === "on");
      }
      break;
    }
    case "preset": {
      const [preset, ...named] = rest;
      let presets: ReturnType<typeof loadFlagPresets>;
      try {
        presets = loadFlagPresets(`${configDir}flags.presets.json`);
      } catch (error) {
        print(error instanceof Error ? error.message : String(error));
        return 1;
      }
      const listed = preset === undefined ? undefined : presets[preset];
      if (listed === undefined) {
        print(
          `Unknown preset: ${preset ?? "(none)"}\nKnown presets: ${Object.keys(presets).join(", ")}`,
        );
        return 1;
      }
      const extra = parseNames(named);
      if (typeof extra === "string") {
        print(`${extra}\n${FLAGS_USAGE}`);
        return 1;
      }
      for (const name of [...listed, ...extra]) {
        changes.set(name, true);
      }
      break;
    }
    default:
      print(`Unknown flags command: ${action}\n${FLAGS_USAGE}`);
      return 1;
  }

  const next: Record<FlagName, boolean> = { ...current.flags };
  const changed: string[] = [];
  for (const [name, value] of changes) {
    if (next[name] !== value) {
      next[name] = value;
      changed.push(`${name} ${value ? "on" : "off"}`);
    }
  }
  if (changed.length === 0) {
    print("No change: the flags are already set.");
    return 0;
  }
  writeAtomically(path, current.order, next);
  print(
    `${changed.join("\n")}\nRestart the app to apply (running servers read the flags at start).`,
  );
  return 0;
}
