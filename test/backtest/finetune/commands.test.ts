import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { datasetCommand } from "../../../src/backtest/dataset-command.js";
import { backtestCommand } from "../../../src/backtest/harness/command.js";
import {
  habitsDigest,
  loadSyntheticHabits,
  parseSnapshot,
  readSnapshot,
  writeSnapshot,
  type WeatherSnapshot,
} from "../../../src/backtest/index.js";
import { snapshotCommand } from "../../../src/backtest/snapshot-command.js";
import { CONFIG_DIR } from "../../../src/server/config.js";
import { fakeOpenMeteo, syntheticSnapshot } from "../support/synthetic-weather.js";

import { configDirWith, outDir, parseLines, tempDir } from "./support.js";

vi.setConfig({ testTimeout: 60_000 });

async function snapshotOnDisk(): Promise<{ root: string; directory: string }> {
  const snapshot: WeatherSnapshot = await syntheticSnapshot({
    startDate: "2026-08-20",
    requestedEndDate: "2026-09-08",
  });
  const root = tempDir();
  return { root, directory: await writeSnapshot(root, snapshot) };
}

function run(args: string[], deps: Parameters<typeof datasetCommand>[2] = {}) {
  const lines: string[] = [];
  return datasetCommand(args, (line) => lines.push(line), deps).then((code) => ({
    code,
    text: lines.join("\n"),
  }));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("sib dataset", () => {
  it("writes train.jsonl, holdout.jsonl and manifest.json from a snapshot", async () => {
    const { directory } = await snapshotOnDisk();
    const out = outDir();
    const configDir = configDirWith();
    const { code, text } = await run(["--snapshot", directory, "--out", out], { configDir });
    expect(code, text).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["holdout.jsonl", "manifest.json", "train.jsonl"]);

    const train = parseLines(readFileSync(join(out, "train.jsonl"), "utf8"));
    const holdout = parseLines(readFileSync(join(out, "holdout.jsonl"), "utf8"));
    expect(train.length).toBeGreaterThan(0);
    expect(holdout.length).toBeGreaterThan(0);
    expect(train.every((row) => row.date <= "2026-08-31")).toBe(true);
    expect(holdout.every((row) => row.date >= "2026-09-01")).toBe(true);

    // AC-019.7: hashes of the files that were read, the real rules file, the synthetic habits.
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      rules_json_sha256: string;
      bookmaker_prompt: { version: string };
      snapshot: { end_date: string };
      habit_profile: unknown;
      files: { train: { sha256: string } };
    };
    expect(manifest.rules_json_sha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(CONFIG_DIR, "rules.json"), "utf8"))
        .digest("hex"),
    );
    expect(manifest.bookmaker_prompt.version).toMatch(/^bookmaker\.v\d+$/);
    expect(manifest.snapshot.end_date).toBe("2026-09-08");
    expect(manifest.habit_profile).toEqual(
      Object.fromEntries(
        Object.entries(loadSyntheticHabits()).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    expect(manifest.files.train.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(out, "train.jsonl")))
        .digest("hex"),
    );
    expect(text).toContain("train.jsonl");
  });

  it("NFR-012: running it again gives byte-identical files", async () => {
    const { directory } = await snapshotOnDisk();
    const configDir = configDirWith();
    const first = outDir();
    const second = outDir();
    expect((await run(["--snapshot", directory, "--out", first], { configDir })).code).toBe(0);
    expect((await run(["--snapshot", directory, "--out", second], { configDir })).code).toBe(0);
    for (const name of ["train.jsonl", "holdout.jsonl", "manifest.json"]) {
      expect(readFileSync(join(second, name), "utf8"), name).toBe(
        readFileSync(join(first, name), "utf8"),
      );
    }
  });

  it("finds the only snapshot in the data folder and writes next to it by default", async () => {
    const dataDir = tempDir();
    const snapshot = await syntheticSnapshot({
      startDate: "2026-08-20",
      requestedEndDate: "2026-09-08",
    });
    const directory = await writeSnapshot(join(dataDir, "data-snapshots"), snapshot);
    const { code, text } = await run([], {
      configDir: configDirWith(),
      env: { SIB_DATA_DIR: dataDir },
      homeDir: tempDir(),
      cwd: tempDir(),
    });
    expect(code, text).toBe(0);
    const out = join(dataDir, "datasets", directory.split("/").at(-1) ?? "");
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
  });

  it("AC-019.8: stops and writes nothing when a household value is in a row", async () => {
    const { directory } = await snapshotOnDisk();
    const configDir = configDirWith({
      airConditioning: true,
      heaterThisSeason: true,
      dryer: "heat-pump",
      location: { latitude: 41.3874, longitude: 2.1701 },
      nickname: "zephyr-flat",
    });
    for (const planted of ["the zephyr-flat balcony", "north of 41.3874"]) {
      const habits = join(tempDir(), "habits.json");
      writeFileSync(habits, JSON.stringify({ home: planted }));
      const out = outDir();
      const { code, text } = await run(
        ["--snapshot", directory, "--out", out, "--habits", habits],
        {
          configDir,
        },
      );
      expect(code).toBe(1);
      expect(text).toContain("Dataset NOT written");
      expect(text).toMatch(/household\.json:(nickname|location\.latitude)/);
      expect(text).not.toContain("zephyr");
      expect(text).not.toContain("41.3874");
      expect(readdirSync(out)).toEqual([]);
    }
  });

  it("AC-019.8: the synthetic profile passes against a household with other values", async () => {
    const { directory } = await snapshotOnDisk();
    const configDir = configDirWith({
      airConditioning: true,
      heaterThisSeason: true,
      dryer: "condenser",
      location: { latitude: 41.3874, longitude: 2.1701 },
    });
    const out = outDir();
    expect((await run(["--snapshot", directory, "--out", out], { configDir })).code).toBe(0);
  });

  it("refuses to write inside a git working tree unless git ignores the folder", async () => {
    const { directory } = await snapshotOnDisk();
    const configDir = configDirWith();
    const repo = tempDir();
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), "ignored-out/\n");

    const tracked = join(repo, "out");
    const refused = await run(["--snapshot", directory, "--out", tracked], { configDir });
    expect(refused.code).toBe(1);
    expect(refused.text).toMatch(/inside the git working tree/);
    expect(existsSync(tracked)).toBe(false);

    const ignored = join(repo, "ignored-out");
    expect((await run(["--snapshot", directory, "--out", ignored], { configDir })).code).toBe(0);
    expect(existsSync(join(ignored, "manifest.json"))).toBe(true);
  });

  it("builds from another prompt version and says when there is none", async () => {
    const { directory } = await snapshotOnDisk();
    const configDir = configDirWith();
    const missing = await run(
      ["--snapshot", directory, "--out", outDir(), "--prompt-version", "99"],
      {
        configDir,
      },
    );
    expect(missing.code).toBe(1);
    expect(missing.text).toContain("prompts/bookmaker.v99.md");
    const bad = await run(["--snapshot", directory, "--prompt-version", "latest"], { configDir });
    expect(bad.code).toBe(1);
    expect(bad.text).toContain("--prompt-version must be a number");
  });

  it("gives one-line errors for usage problems", async () => {
    expect((await run(["--bogus"])).code).toBe(1);
    const none = await run([], {
      cwd: tempDir(),
      homeDir: tempDir(),
      env: {},
      configDir: configDirWith(),
    });
    expect(none.code).toBe(1);
    expect(none.text).toContain("No snapshot found");
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.text).toContain("Usage: sib dataset");
  });
});

describe("sib snapshot", () => {
  const NOW = Date.parse("2026-10-23T10:00:00Z");

  function snap(args: string[], deps: Parameters<typeof snapshotCommand>[2] = {}) {
    const lines: string[] = [];
    return snapshotCommand(args, (line) => lines.push(line), { now: () => NOW, ...deps }).then(
      (code) => ({ code, text: lines.join("\n") }),
    );
  }

  it("fetches through the injected client and saves the snapshot outside the repository", async () => {
    const calls: { url: string }[] = [];
    const out = join(tempDir(), "snapshots");
    const { code, text } = await snap(
      ["--out", out, "--start", "2026-08-24", "--end", "2026-09-06"],
      {
        fetchJson: fakeOpenMeteo({}, calls),
      },
    );
    expect(code, text).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    const [name] = readdirSync(out);
    expect(name).toBe("gracia-barcelona_2026-08-24_2026-09-06");
    const snapshot = await readSnapshot(join(out, name ?? ""));
    expect(snapshot.startDate).toBe("2026-08-24");
    expect(snapshot.fetchedAt).toBe("2026-10-23T10:00:00.000Z");
    expect(snapshot.location.latitude).toBe(41.4);
    expect(text).toContain("Open-Meteo");
  });

  it("defaults to <data folder>/data-snapshots, starting 1 Apr and ending yesterday (Madrid)", async () => {
    const dataDir = tempDir();
    const calls: { url: string }[] = [];
    const { code, text } = await snap([], {
      env: { SIB_DATA_DIR: dataDir },
      homeDir: tempDir(),
      fetchJson: fakeOpenMeteo({}, calls),
    });
    expect(code, text).toBe(0);
    const [name] = readdirSync(join(dataDir, "data-snapshots"));
    expect(name).toBe("gracia-barcelona_2026-04-01_2026-10-22");
    expect(calls.some((call) => call.url.includes("end_date=2026-10-22"))).toBe(true);
  });

  it("refuses a folder inside a git working tree before it fetches anything", async () => {
    const repo = tempDir();
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), "kept/\n");
    const calls: { url: string }[] = [];
    const refused = await snap(["--out", join(repo, "snapshots")], {
      fetchJson: fakeOpenMeteo({}, calls),
    });
    expect(refused.code).toBe(1);
    expect(refused.text).toMatch(/inside the git working tree/);
    expect(calls).toEqual([]);

    const kept = join(repo, "kept");
    const allowed = await snap(["--out", kept, "--start", "2026-08-24", "--end", "2026-09-06"], {
      fetchJson: fakeOpenMeteo({}),
    });
    expect(allowed.code, allowed.text).toBe(0);
    expect(readdirSync(kept)).toHaveLength(1);
  });

  it("reports a failed fetch in one line and writes nothing", async () => {
    const out = join(tempDir(), "snapshots");
    const failed = await snap(["--out", out], {
      fetchJson: () => Promise.reject(new Error("Open-Meteo answered 429")),
    });
    expect(failed.code).toBe(1);
    expect(failed.text).toBe(
      "Fetching Gràcia, Barcelona 2026-04-01 to 2026-10-22 from Open-Meteo ...\nSnapshot failed: Open-Meteo answered 429",
    );
    expect(existsSync(out)).toBe(false);
  });

  it("checks its options", async () => {
    expect((await snap(["--start", "April"])).code).toBe(1);
    expect((await snap(["--start", "2026-05-01", "--end", "2026-04-01"])).code).toBe(1);
    expect((await snap(["--nope"])).code).toBe(1);
    expect((await snap(["--help"])).code).toBe(0);
  });

  it("round-trips: the saved file parses as the snapshot the fetch built", async () => {
    const out = join(tempDir(), "snapshots");
    await snap(["--out", out, "--start", "2026-08-24", "--end", "2026-09-06"], {
      fetchJson: fakeOpenMeteo({}),
    });
    const name = readdirSync(out)[0] ?? "";
    const text = readFileSync(join(out, name, "snapshot.json"), "utf8");
    expect(parseSnapshot(JSON.parse(text) as unknown).endDate).toBe("2026-09-06");
  });
});

describe("sib backtest: the default habits are the fixed synthetic profile", () => {
  it("shows the synthetic habits to the bookmaker and records them as a count and a hash", async () => {
    const { directory } = await snapshotOnDisk();
    const out = tempDir();
    const code = await backtestCommand(
      ["--snapshot", directory, "--out", out, "--fake-model", "--strategies", "rule"],
      () => undefined,
      { env: {}, homeDir: tempDir() },
    );
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, "report-rule-all.json"), "utf8")) as {
      method: { habits: { entries: number; sha256: string | null } };
    };
    const synthetic = loadSyntheticHabits();
    expect(report.method.habits).toEqual({
      entries: Object.keys(synthetic).length,
      sha256: habitsDigest(synthetic),
    });
    expect(report.method.habits.entries).toBeGreaterThan(0);
  });
});
