import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR } from "../server/config.js";
import { DATABASE_FILE } from "../server/data-dir.js";
import { migrate, openDatabase } from "../server/db.js";
import { loadFlagPresets, PRESENTATION_PRESET } from "../server/flag-presets.js";
import { FLAG_NAMES, parseFlags, type Flags } from "../server/flags.js";
import { startServer, type RunningServer } from "../server/main.js";
import { MIGRATIONS } from "../server/migrations/index.js";

import { DEMO_NOW, SAMPLE_HOUSEHOLD, seedDemoData } from "./seed.js";

/** The port of `sib demo` unless `--port` says otherwise: next to the app's own 8787. */
export const DEMO_PORT = 8788;

const DEMO_USAGE = "Usage: sib demo [--port N]";

/**
 * The only files `sib demo` takes from the repository's `config/`: committed and free of
 * household data. `household.json` and `server.json` are never in the list, so the demo cannot
 * read them even if they exist (AC-029.4).
 */
const COMMITTED_CONFIG_FILES = ["models.json", "server.example.json"] as const;

export interface DemoOptions {
  readonly port?: number;
  /** The repository's `config/` folder (with a trailing slash); tests give a copy with canaries. */
  readonly committedConfigDir?: string;
  /** Where the temporary folder is made; the system's temp folder by default. */
  readonly parentDir?: string;
  readonly output?: (text: string) => void;
}

export interface RunningDemo {
  readonly server: RunningServer;
  /** The temporary folder holding the data folder and the config copy. */
  readonly tempDir: string;
  readonly dataDir: string;
  /** Stops the server and deletes the temporary folder. */
  close(): Promise<void>;
}

/** The flags of the `presentation` preset, applied in memory over "all off" (AC-029.3, AC-029.4). */
export function demoFlags(committedConfigDir: string = CONFIG_DIR): Flags {
  const preset = loadFlagPresets(`${committedConfigDir}flags.presets.json`)[PRESENTATION_PRESET];
  if (preset === undefined) {
    throw new Error(`config/flags.presets.json has no "${PRESENTATION_PRESET}" preset`);
  }
  return parseFlags(
    Object.fromEntries(
      FLAG_NAMES.map((name) => [name, (preset as readonly string[]).includes(name)]),
    ),
  );
}

/**
 * Makes the temporary folder, seeds it and starts the server on it with the fake model, the fake
 * weather, a fixed clock and the preset's flags (AC-029.4). It never opens the live data folder
 * (`~/.should-i-bother`, `SIB_DATA_DIR`), `config/household.json` or `config/server.json`, and
 * never writes `config/flags.json`. The temporary folder is removed if anything fails.
 */
export async function startDemo(options: DemoOptions = {}): Promise<RunningDemo> {
  const committed = options.committedConfigDir ?? CONFIG_DIR;
  const output = options.output ?? ((text: string) => console.error(text));
  const flags = demoFlags(committed);

  const tempDir = mkdtempSync(join(options.parentDir ?? tmpdir(), "sib-demo-"));
  const dataDir = join(tempDir, "data");
  const configDir = `${join(tempDir, "config")}/`;
  const remove = (): void => {
    rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    mkdirSync(dataDir, { mode: 0o700 });
    mkdirSync(configDir, { mode: 0o700 });
    for (const name of COMMITTED_CONFIG_FILES) {
      copyFileSync(join(committed, name), join(configDir, name));
    }
    writeFileSync(
      join(configDir, "household.example.json"),
      `${JSON.stringify({ _comment: "Sample flat: made up for sib demo.", ...SAMPLE_HOUSEHOLD }, null, 2)}\n`,
    );

    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      migrate(db, MIGRATIONS);
      const seeded = await seedDemoData({ db, dataDir, flags });
      output(
        `Sample data ready: ${String(seeded.cards)} cards and ${String(seeded.bets)} bets over two weeks (synthetic).`,
      );
    } finally {
      db.close();
    }

    const port = options.port ?? DEMO_PORT;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SIB_DATA_DIR: dataDir,
      SIB_PORT: String(port),
      SIB_FAKE_MODEL: "1",
      SIB_FAKE_WEATHER: "1",
    };
    const server = await startServer(env, {
      configDir,
      output,
      demo: { now: () => DEMO_NOW, flags },
    });
    output(
      [
        "",
        "SAMPLE DATA: made-up bets, fake model, fake weather, a fixed date (23 Oct 2026, 10:00).",
        `Nothing here is a result. Temporary data in ${tempDir} is deleted when you stop (Ctrl+C).`,
      ].join("\n"),
    );
    return {
      server,
      tempDir,
      dataDir,
      close: async () => {
        try {
          await server.close();
        } finally {
          remove();
        }
      },
    };
  } catch (error) {
    remove();
    throw error;
  }
}

function parsePort(args: readonly string[]): number | undefined | "invalid" {
  const index = args.indexOf("--port");
  if (index === -1) {
    return args.length === 0 ? undefined : "invalid";
  }
  const value = args[index + 1];
  const port = Number(value);
  if (
    args.length !== 2 ||
    value === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return "invalid";
  }
  return port;
}

/**
 * `sib demo [--port N]`: runs until Ctrl+C or SIGTERM, then stops the server and deletes the
 * temporary folder. Returns the exit code of the start.
 */
export async function demoCommand(
  args: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  const port = parsePort(args);
  if (port === "invalid") {
    print(DEMO_USAGE);
    return 1;
  }
  const demo = await startDemo({ ...(port === undefined ? {} : { port }), output: print });
  // A last resort if the process ends in a way the handlers miss (an uncaught error).
  process.once("exit", () => {
    if (existsSync(demo.tempDir)) {
      rmSync(demo.tempDir, { recursive: true, force: true });
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      demo.close().then(
        () => {
          print("Sample data deleted.");
        },
        (error: unknown) => {
          console.error("Shutdown failed:", error);
          process.exitCode = 1;
        },
      );
    });
  }
  return 0;
}
