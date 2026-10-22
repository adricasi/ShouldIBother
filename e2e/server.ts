import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

const ROOT = new URL("../", import.meta.url).pathname;
const START_TIMEOUT_MS = 30_000;

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
  private readonly dataDir = mkdtempSync(join(tmpdir(), "sib-e2e-"));
  /** The pairing link printed at the first start. */
  pairUrl = "";

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.port === 0) {
      this.port = await freePort();
    }
    const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/cli.ts", "start"], {
      cwd: ROOT,
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
    if (this.pairUrl === "") {
      this.pairUrl = link;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    this.child = undefined;
    child.removeAllListeners("exit");
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  /** Moves every open bet to a time that has passed, as if the night had gone by. Server stopped. */
  makeBetsDue(hours = 24): void {
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
  }
}
