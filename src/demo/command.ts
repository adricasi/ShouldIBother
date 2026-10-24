import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR } from "../server/config.js";
import { DATABASE_FILE } from "../server/data-dir.js";
import { migrate, openDatabase } from "../server/db.js";
import { loadFlagPresets, PRESENTATION_PRESET } from "../server/flag-presets.js";
import { FLAG_NAMES, parseFlags, type Flags } from "../server/flags.js";
import { startServer, type RunningServer } from "../server/main.js";
import { MIGRATIONS } from "../server/migrations/index.js";

import { DEMO_NOW, SAMPLE_HOUSEHOLD, seedDemoData } from "./seed.js";

/** What the guard needs of `process`; tests give a stand-in. */
export interface GuardedProcess {
  on(event: "exit" | NodeJS.Signals, listener: () => void): unknown;
  off(event: "exit" | NodeJS.Signals, listener: () => void): unknown;
  exit(code?: number): unknown;
  exitCode?: number | string | null | undefined;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Makes sure the temporary folder never outlives the demo. It is installed before the folder is
 * made, so a signal during the seeding (which takes a second or two) is covered:
 *
 * - a signal while the demo is starting removes the folder at once and exits;
 * - the first signal while it runs stops the server, then removes the folder;
 * - a repeated signal removes the folder synchronously and exits;
 * - any other end of the process (an uncaught error) removes it in the `exit` event.
 */
export class DemoGuard {
  private dir: string | undefined;
  private stop: (() => Promise<void>) | undefined;
  private stopping = false;
  private readonly onExit = (): void => {
    this.removeNow();
  };
  private readonly onSignal = new Map<NodeJS.Signals, () => void>();

  constructor(
    private readonly proc: GuardedProcess = process,
    private readonly print: (text: string) => void = (text) => {
      console.error(text);
    },
  ) {
    this.proc.on("exit", this.onExit);
    for (const signal of SIGNALS) {
      const listener = (): void => {
        this.handle(signal);
      };
      this.onSignal.set(signal, listener);
      this.proc.on(signal, listener);
    }
  }

  /** The folder to protect, called right after it is made. */
  track(dir: string): void {
    this.dir = dir;
  }

  /** The demo is up: the first signal now stops it cleanly. */
  running(stop: () => Promise<void>): void {
    this.stop = stop;
  }

  private removeNow(): void {
    if (this.dir !== undefined) {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  private handle(signal: NodeJS.Signals): void {
    const code = 128 + (osConstants.signals[signal] ?? 0);
    if (this.stopping || this.stop === undefined) {
      // Starting, or a second signal while stopping: no time to wait.
      this.removeNow();
      this.proc.exit(this.stopping ? 1 : code);
      return;
    }
    this.stopping = true;
    this.stop().then(
      () => {
        this.print("Sample data deleted.");
      },
      (error: unknown) => {
        console.error("Shutdown failed:", error);
        this.removeNow();
        this.proc.exitCode = 1;
      },
    );
  }
}

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
  /** Removes the temporary folder on a signal or at exit; `demoCommand` sets it up first. */
  readonly guard?: DemoGuard;
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
  const listed = new Set<string>(preset);
  return parseFlags(Object.fromEntries(FLAG_NAMES.map((name) => [name, listed.has(name)])));
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
  options.guard?.track(tempDir);
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
    const close = async (): Promise<void> => {
      try {
        await server.close();
      } finally {
        remove();
      }
    };
    options.guard?.running(close);
    return { server, tempDir, dataDir, close };
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
  // First, before the folder exists: a signal during the seeding must not leave it behind.
  const guard = new DemoGuard(process, print);
  await startDemo({ ...(port === undefined ? {} : { port }), output: print, guard });
  return 0;
}
