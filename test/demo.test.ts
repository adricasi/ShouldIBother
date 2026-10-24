import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { demoFlags, startDemo, type RunningDemo } from "../src/demo/command.js";
import { SAMPLE_PLACE_LABEL, seedDemoData } from "../src/demo/seed.js";
import { CONFIG_DIR } from "../src/server/config.js";
import { exportCommand } from "../src/server/data-commands.js";
import { DEMO_EXPORT_REFUSAL, DEMO_MARKER_FILE, DEMO_MODEL } from "../src/server/demo.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { FLAG_NAMES, loadFlags } from "../src/server/flags.js";
import { getScore } from "../src/server/ledger/score.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import type { Runtime } from "../src/server/runtime.js";
import { loadRules } from "../src/server/rules.js";

import { cookieHeaderFrom } from "./helpers.js";

const ROOT = new URL("../", import.meta.url).pathname;

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

/** Every file under `dir` with its content and modification time, to prove nothing changed. */
function snapshot(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        found.push(`${path}/`);
        walk(path);
      } else {
        found.push(`${path} ${readFileSync(path, "utf8")} ${String(statSync(path).mtimeMs)}`);
      }
    }
  };
  walk(dir);
  return found;
}

describe("sib demo: isolation, seed coverage and cleanup (AC-029.4)", () => {
  const root = mkdtempSync(join(tmpdir(), "sib-demo-test-"));
  const home = join(root, "home");
  const liveData = join(root, "live-data");
  const canaryConfig = `${join(root, "config")}/`;
  const parent = join(root, "tmp");
  let demo: RunningDemo;
  let port = 0;
  let canaryBefore: string[] = [];
  let configBefore: string[] = [];
  const printed: string[] = [];

  beforeAll(async () => {
    for (const dir of [home, liveData, canaryConfig, parent]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(liveData, "sentinel.txt"), "live household data");
    writeFileSync(join(home, "sentinel.txt"), "home");
    // The committed files, plus the private ones a laptop has: the demo must not even open them.
    for (const name of [
      "models.json",
      "server.example.json",
      "household.example.json",
      "flags.json",
      "flags.presets.json",
    ]) {
      copyFileSync(join(CONFIG_DIR, name), join(canaryConfig, name));
    }
    writeFileSync(
      join(canaryConfig, "household.json"),
      JSON.stringify({ airConditioning: false, heaterThisSeason: false, dryer: "none" }),
    );
    writeFileSync(join(canaryConfig, "server.json"), "{ this is not json, it was opened");
    vi.stubEnv("HOME", home);
    vi.stubEnv("SIB_DATA_DIR", liveData);
    canaryBefore = [...snapshot(home), ...snapshot(liveData)];
    configBefore = snapshot(canaryConfig);
    port = await freePort();
    demo = await startDemo({
      port,
      committedConfigDir: canaryConfig,
      parentDir: parent,
      output: (text) => printed.push(text),
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await demo.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  async function get<T>(path: string, cookie: string): Promise<T> {
    const response = await demo.server.app.inject({
      method: "GET",
      url: path,
      headers: { host: `127.0.0.1:${String(port)}`, cookie },
    });
    expect(response.statusCode, path).toBe(200);
    return response.json<T>();
  }

  async function pair(): Promise<string> {
    const { token } = demo.server.runtime.store.issuePairingToken();
    return cookieHeaderFrom(
      await demo.server.app.inject({
        method: "GET",
        url: `/pair?token=${token}`,
        headers: { host: `127.0.0.1:${String(port)}` },
      }),
    );
  }

  it("AC-029.4: never reads or writes the live data folder, HOME or the private config", () => {
    expect(demo.dataDir.startsWith(parent)).toBe(true);
    expect([...snapshot(home), ...snapshot(liveData)]).toEqual(canaryBefore);
    expect(existsSync(join(home, ".should-i-bother"))).toBe(false);
    // A server.json that is not JSON would have failed the start if it had been read.
    expect(snapshot(canaryConfig)).toEqual(configBefore);
    expect(printed.join("\n")).toContain("SAMPLE DATA");
  });

  it("AC-029.4: runs on the household of the sample, not config/household.json", async () => {
    const cookie = await pair();
    const onboarding = await get<{ state: string; household: { dryer: string } }>(
      "/api/onboarding",
      cookie,
    );
    expect(onboarding.state).toBe("completed");
    expect(onboarding.household.dryer).toBe("condenser");
    const today = await get<{ weather_board: { place_label?: string } | null }>(
      "/api/today",
      cookie,
    );
    expect(today.weather_board?.place_label).toBe(SAMPLE_PLACE_LABEL);
  });

  it("AC-029.3, AC-029.4: the presentation preset is applied in memory, voice and finetunedBookmaker stay off", async () => {
    const cookie = await pair();
    const today = await get<{ demo: boolean; flags: Record<string, boolean> }>(
      "/api/today",
      cookie,
    );
    expect(today.demo).toBe(true);
    for (const name of FLAG_NAMES) {
      expect(today.flags[name], name).toBe(name !== "voice" && name !== "finetunedBookmaker");
    }
    expect(demoFlags(canaryConfig)).toEqual(today.flags);
    // The committed defaults are not touched.
    expect(loadFlags(`${canaryConfig}flags.json`).score).toBe(false);
    expect(loadFlags(`${CONFIG_DIR}flags.json`).score).toBe(false);
  });

  it("AC-029.4: Today has cards, alerts, notices, open bets and one due bet", async () => {
    const today = await get<{
      cards: { kind: string; notice: string | null }[];
      open_bets: unknown[];
      due_bets: unknown[];
      points: { total: number };
    }>("/api/today", await pair());
    expect(new Set(today.cards.map((card) => card.kind))).toEqual(
      new Set(["weather", "alert", "coming_later"]),
    );
    expect(today.open_bets.length).toBeGreaterThanOrEqual(3);
    expect(today.due_bets).toHaveLength(1);
    expect(today.points.total).toBeGreaterThan(200);
  });

  it("AC-029.4: Slips has every group, every evidence, a cash-out and an appeal", async () => {
    const cookie = await pair();
    const slips = await get<{
      settle_now: unknown[];
      waiting: unknown[];
      settled: {
        id: number;
        chore_type: string;
        kind: string;
        result: { verdict: string; evidence: string };
      }[];
    }>("/api/slips", cookie);
    expect(slips.settle_now.length).toBeGreaterThanOrEqual(1);
    expect(slips.waiting.length).toBeGreaterThanOrEqual(3);
    expect(slips.settled.length).toBeGreaterThanOrEqual(30);
    const evidence = new Set(slips.settled.map((bet) => bet.result.evidence));
    expect(evidence).toEqual(new Set(["photo", "tap", "auto", "none"]));
    const verdicts = new Set(slips.settled.map((bet) => bet.result.verdict));
    for (const verdict of ["win", "small_loss", "normal_loss", "cash_out", "weather_would_not"]) {
      expect(verdicts.has(verdict), verdict).toBe(true);
    }
    const chores = new Set(slips.settled.map((bet) => bet.chore_type));
    expect(chores).toEqual(new Set(["plants", "laundry_line", "laundry_tonight", "ac", "heater"]));

    const receipts = await Promise.all(
      slips.settled
        .filter((bet) => bet.kind === "do_nothing")
        .map((bet) =>
          get<{
            outcome: string;
            lucky_win: boolean | null;
            appeal?: { changed: boolean };
            evidence: { kind: string };
          }>(`/api/bets/${String(bet.id)}/receipt`, cookie),
        ),
    );
    expect(receipts.some((receipt) => receipt.outcome === "paid_out")).toBe(true);
    expect(receipts.some((receipt) => receipt.lucky_win === true)).toBe(true);
    expect(receipts.some((receipt) => receipt.appeal?.changed === true)).toBe(true);
    expect(receipts.some((receipt) => receipt.appeal?.changed === false)).toBe(true);
  });

  it("AC-029.4: Score has rank, achievements, calibration for Gemma and the rule, marked as sample", async () => {
    const score = await get<{
      demo: boolean;
      rank: { id: string };
      achievements: { unlocked_at: string | null }[];
      judge: { appeals: string; n: number; overruled: number };
      calibration: {
        settled: number;
        gemma: { n: number; too_few: boolean }[];
        rule: { n: number }[];
        lucky_wins: { lucky_wins: number };
        fake_model_bets: number;
      };
    }>("/api/score", await pair());
    expect(score.demo).toBe(true);
    expect(score.rank.id).not.toBe("hyperactive_squirrel");
    expect(score.achievements.every((item) => item.unlocked_at !== null)).toBe(true);
    expect(score.judge).toMatchObject({ appeals: "on" });
    expect(score.judge.n).toBeGreaterThan(20);
    expect(score.judge.overruled).toBeGreaterThanOrEqual(1);
    expect(score.calibration.gemma.filter((band) => band.n > 0)).toHaveLength(5);
    expect(score.calibration.gemma.some((band) => !band.too_few)).toBe(true);
    expect(score.calibration.rule.filter((band) => band.n > 0).length).toBeGreaterThanOrEqual(4);
    expect(score.calibration.lucky_wins.lucky_wins).toBeGreaterThan(0);
    expect(score.calibration.fake_model_bets).toBe(0);
  });

  it("NFR-010: seeded Gemma rows carry fake-demo, and Score counts them in demo mode only", () => {
    const db = new Database(join(demo.dataDir, "sib.db"), { readonly: true });
    try {
      const versions = db
        .prepare<[], { v: string | null; source: string }>(
          "SELECT DISTINCT model_version AS v, odds_source AS source FROM bets",
        )
        .all();
      expect(versions).toContainEqual({ v: DEMO_MODEL, source: "gemma" });
      expect(versions).toContainEqual({ v: null, source: "rule" });
      expect(versions).toHaveLength(2);
      const models = db
        .prepare<[], { model: string; valid: number }>(
          "SELECT DISTINCT model, valid FROM gemma_decisions",
        )
        .all();
      // Every answered job is the demo model; the only other rows are Gemma-offline attempts.
      expect(models.filter((row) => row.valid === 1)).toEqual([{ model: DEMO_MODEL, valid: 1 }]);
      expect(models.filter((row) => row.valid === 0).every((row) => row.model === "unknown")).toBe(
        true,
      );

      const deps = { db, rules: loadRules(), flags: demoFlags(), now: () => Date.now() };
      const inDemo = getScore({ ...deps, demo: true });
      const outside = getScore(deps);
      expect(inDemo.calibration.gemma.reduce((sum, band) => sum + band.n, 0)).toBeGreaterThan(20);
      expect(outside.calibration.gemma.reduce((sum, band) => sum + band.n, 0)).toBe(0);
      expect(outside.calibration.fake_model_bets).toBeGreaterThan(20);
      expect(outside.judge).toMatchObject({ appeals: "on", n: 0 });
      // The rule's chart does not depend on the model.
      expect(outside.calibration.rule).toEqual(inDemo.calibration.rule);
    } finally {
      db.close();
    }
  });

  it("AC-029.4: sib export refuses a data folder marked as sample data and writes nothing", () => {
    expect(existsSync(join(demo.dataDir, DEMO_MARKER_FILE))).toBe(true);
    const db = new Database(join(demo.dataDir, "sib.db"));
    const target = join(root, "exported");
    expect(() =>
      exportCommand({ db, dataDir: demo.dataDir } as unknown as Runtime, target, () => undefined),
    ).toThrow(DEMO_EXPORT_REFUSAL);
    expect(existsSync(target)).toBe(false);
  });

  it("AC-029.4: the temporary folder is deleted when the demo stops", async () => {
    const tempDir = demo.tempDir;
    expect(existsSync(tempDir)).toBe(true);
    await demo.close();
    expect(existsSync(tempDir)).toBe(false);
    // The live folder is still exactly what it was.
    expect([...snapshot(home), ...snapshot(liveData)]).toEqual(canaryBefore);
  });
});

describe("sib demo: the real command (AC-029.4)", () => {
  const root = mkdtempSync(join(tmpdir(), "sib-demo-cli-"));
  const committedFlags = readFileSync(join(CONFIG_DIR, "flags.json"), "utf8");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "deletes its temporary folder on %s and leaves the live data and flags alone",
    async (signal) => {
      const home = join(root, `home-${signal}`);
      const liveData = join(root, `live-${signal}`);
      mkdirSync(home);
      mkdirSync(liveData);
      const before = [...snapshot(home), ...snapshot(liveData)];
      const child = spawn(
        join(ROOT, "node_modules/.bin/tsx"),
        ["src/cli.ts", "demo", "--port", String(await freePort())],
        {
          cwd: ROOT,
          env: { ...process.env, HOME: home, SIB_DATA_DIR: liveData },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let output = "";
      const tempDir = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`sib demo did not start:\n${output}`));
        }, 40_000);
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const found = /Temporary data in (\S+) is deleted/.exec(output);
          if (found?.[1] !== undefined) {
            clearTimeout(timer);
            resolve(found[1]);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`sib demo exited with ${String(code)}:\n${output}`));
        });
      });
      expect(existsSync(tempDir)).toBe(true);
      expect(output).toMatch(/http:\/\/127\.0\.0\.1:\d+\/pair\?token=/);
      const exit = new Promise<number | null>((resolve) => {
        child.removeAllListeners("exit");
        child.once("exit", resolve);
      });
      child.kill(signal);
      expect(await exit).toBe(0);
      expect(existsSync(tempDir)).toBe(false);
      expect([...snapshot(home), ...snapshot(liveData)]).toEqual(before);
      expect(readFileSync(join(CONFIG_DIR, "flags.json"), "utf8")).toBe(committedFlags);
    },
    90_000,
  );

  it("refuses bad options with the usage and exit code 1", async () => {
    const { demoCommand } = await import("../src/demo/command.js");
    const lines: string[] = [];
    for (const args of [["--port"], ["--port", "0"], ["--port", "x"], ["--nope"], ["8788"]]) {
      expect(await demoCommand(args, (text) => lines.push(text))).toBe(1);
    }
    expect(lines.every((line) => line.startsWith("Usage: sib demo"))).toBe(true);
  });
});

describe("seedDemoData is deterministic", () => {
  it("AC-029.4: two runs make the same history", async () => {
    const make = async (): Promise<unknown> => {
      const dir = mkdtempSync(join(tmpdir(), "sib-seed-"));
      const db = openDatabase(join(dir, "sib.db"));
      try {
        migrate(db, MIGRATIONS);
        await seedDemoData({ db, dataDir: dir, flags: demoFlags() });
        return db
          .prepare(
            `SELECT b.card_id, b.kind, b.odds, b.band, b.status, b.placed_at, b.settle_at,
                    s.verdict, s.evidence, s.points
             FROM bets b LEFT JOIN settlements s ON s.bet_id = b.id ORDER BY b.id, s.id`,
          )
          .all();
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(await make()).toEqual(await make());
  }, 60_000);
});
