import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import Database from "better-sqlite3";

const ROOT = new URL("../", import.meta.url).pathname;
const START_TIMEOUT_MS = 30_000;
const KILL_AFTER_MS = 5_000;
const TEMP_PREFIX = "sib-e2e-";

/** Local, git-ignored config that holds real household values (NFR-002): never given to the test. */
const PRIVATE_CONFIG = new Set(["household.json", "server.json"]);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * The real server on a temporary data folder with the fake model and the fake weather: no GPU,
 * no model, no network, no household data. It can be stopped and started again on the same data
 * so a bet's settle time can be moved into the past between the two.
 */
export class TestServer {
  private child: ChildProcess | undefined;
  private port = 0;
  private readonly dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  /**
   * The server reads `config/`, `prompts/` and `dist/web/` relative to its own source, with no
   * override for the config folder. So it runs from a copy of the committed files in a temp
   * folder, without the git-ignored `config/household.json` and `config/server.json`:
   * the test never sees real household values.
   */
  private readonly appDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  /** The pairing link printed at the first start. */
  pairUrl = "";
  /** The pairing link printed at the latest start (a restart prints a new one). */
  latestPairUrl = "";

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private prepareAppCopy(): void {
    for (const folder of ["src", "config", "prompts", "test/fixtures", "dist/web"]) {
      cpSync(join(ROOT, folder), join(this.appDir, folder), {
        recursive: true,
        filter: (source) => !PRIVATE_CONFIG.has(basename(source)),
      });
    }
    for (const file of ["package.json", "tsconfig.json"]) {
      cpSync(join(ROOT, file), join(this.appDir, file));
    }
    symlinkSync(join(ROOT, "node_modules"), join(this.appDir, "node_modules"), "dir");
  }

  async start(): Promise<void> {
    if (this.port === 0) {
      this.port = await freePort();
      this.prepareAppCopy();
    }
    const child = spawn(join(this.appDir, "node_modules/.bin/tsx"), ["src/cli.ts", "start"], {
      cwd: this.appDir,
      env: {
        ...process.env,
        SIB_FAKE_MODEL: "1",
        SIB_FAKE_WEATHER: "1",
        SIB_DATA_DIR: this.dataDir,
        SIB_PORT: String(this.port),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    const link = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        reject(new Error(`The server did not print its pairing link:\n${output}`));
      }, START_TIMEOUT_MS);
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const found = /http:\/\/127\.0\.0\.1:\d+\/pair\?token=\S+/.exec(output);
        if (found !== null) {
          clearTimeout(timer);
          resolve(found[0]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`The server exited with ${String(code)}:\n${output}`));
      });
    });
    this.latestPairUrl = link;
    if (this.pairUrl === "") {
      this.pairUrl = link;
    }
  }

  /**
   * Turns feature flags on or off in the server's own copy of `config/flags.json` (never the
   * repository's). The server must be stopped; the next start reads them.
   */
  setFlags(flags: Readonly<Record<string, boolean>>): void {
    if (this.port === 0) {
      throw new Error("Start the server once before setting flags: the app copy is made then.");
    }
    const path = join(this.appDir, "config/flags.json");
    const current = JSON.parse(readFileSync(path, { encoding: "utf8" })) as Record<string, boolean>;
    writeFileSync(path, JSON.stringify({ ...current, ...flags }, null, 2));
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    this.child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.removeAllListeners("exit");
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_AFTER_MS);
      child.once("exit", () => {
        clearTimeout(killer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  /**
   * Moves every open bet to a time that has passed, as if the night had gone by. The server must
   * be stopped. This drops a database trigger: it must NEVER point at a real data folder, so it
   * refuses any folder this class did not create in the temp directory.
   */
  makeBetsDue(hours = 24): void {
    if (!this.dataDir.startsWith(join(tmpdir(), TEMP_PREFIX))) {
      throw new Error(`Refusing to change a database outside the e2e temp folder: ${this.dataDir}`);
    }
    const db = new Database(join(this.dataDir, "sib.db"));
    try {
      const shift = hours * 3_600_000;
      // A bet's times are locked by a trigger (REQ-006). This database is a throwaway copy made
      // by this test, so the trigger goes; the server cannot be given a different clock.
      db.exec("DROP TRIGGER bets_locked_columns");
      db.prepare(
        "UPDATE bets SET placed_at = placed_at - ?, settle_at = ?, undo_until = undo_until - ? WHERE status = 'open'",
      ).run(shift, Date.now() - 3_600_000, shift);
    } finally {
      db.close();
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
    rmSync(this.appDir, { recursive: true, force: true });
  }
}
