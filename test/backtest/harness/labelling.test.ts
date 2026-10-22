import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TOOL_HORIZON_HOURS,
  backtestCommand,
  buildCases,
  summarisePeriod,
  type BacktestReport,
  type DecisionRecord,
} from "../../../src/backtest/harness/index.js";
import { CHORES } from "../../../src/domain/chores.js";
import { HOUR_MS, madridWallTimeToEpochMs } from "../../../src/domain/outcomes.js";
import {
  CATALOGUE,
  RULES,
  configDirWith,
  fakeOllama,
  reportFile,
  sliceSnapshot,
  snapshotOnDisk,
  tempDir,
} from "./support.js";

const FAKE = ["--fake-model", "--strategies", "rule,fixed,e2b,e4b"];

describe("AC-018.2: results are split by forecast quality", () => {
  it("keeps short-lead days out of the headline numbers and the calibration, and lists them apart", async () => {
    // 2 Sep has no day-1 values: every variable of that day falls back to the Historical Forecast.
    const snapshot = await sliceSnapshot({ previousRunsNullDates: ["2026-09-02"] });
    const snapshotDir = await snapshotOnDisk(snapshot);
    const out = tempDir();
    const lines: string[] = [];
    expect(
      await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    const report = JSON.parse(readFileSync(reportFile(out, "json"), "utf8")) as BacktestReport;

    const cases = buildCases(snapshot, RULES).cases.filter((c) => c.split === "holdout");
    const day1 = cases.filter((c) => c.input.forecast.quality === "day1_previous_runs");
    const shortLead = cases.filter(
      (c) => c.input.forecast.quality === "short_lead_forecast_optimistic",
    );
    expect(shortLead.length).toBeGreaterThan(3);

    for (const result of report.results) {
      expect(result.holdout?.decisions).toBe(day1.length);
      expect(result.fallbackForecasts.holdout.short_lead_forecast_optimistic?.decisions).toBe(
        shortLead.length,
      );
      expect(result.fallbackForecasts.holdout.perfect_forecast_upper_bound).toBeNull();
      const calibration = result.holdout?.calibration;
      if (calibration?.status === "ok") {
        // N in the headline calibration never includes a fallback day.
        expect(calibration.n).toBeLessThanOrEqual(day1.length);
      }
    }
    expect(report.forecastData.holdout.byQuality).toMatchObject({
      day1_previous_runs: day1.length,
      short_lead_forecast_optimistic: shortLead.length,
    });

    const markdown = readFileSync(reportFile(out, "md"), "utf8");
    expect(markdown).toContain("## Days on fallback forecasts");
    expect(markdown).toContain(
      `**Hold-out: short-lead forecast (optimistic)** (${shortLead.length} days)`,
    );
  });

  it("a snapshot with no day-1 days has an empty headline and all days in the labelled breakdown", async () => {
    const snapshot = await sliceSnapshot({ previousRunsOmit: ["wind_gusts_10m"] });
    const snapshotDir = await snapshotOnDisk(snapshot);
    const out = tempDir();
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], () => undefined);
    const report = JSON.parse(readFileSync(reportFile(out, "json"), "utf8")) as BacktestReport;
    for (const result of report.results) {
      expect(result.holdout).toBeNull();
      expect(result.inSample).toBeNull();
      expect(result.fallbackForecasts.holdout.short_lead_forecast_optimistic).not.toBeNull();
    }
    expect(readFileSync(reportFile(out, "md"), "utf8")).toContain("No decisions in this period.");
  });
});

describe("the get_forecast horizon (the same for the live tool and for T-031)", () => {
  it("covers every chore's settle bounds, 24 h from the decision hour, none issued after the decision", async () => {
    const { cases } = buildCases(await sliceSnapshot(), RULES);
    expect(TOOL_HORIZON_HOURS).toBe(24);
    const covered = cases.filter((c) => c.input.date <= "2026-09-03");
    expect(covered.length).toBeGreaterThan(30);
    for (const c of covered) {
      const last = c.input.toolHours.at(-1)!;
      expect(last.startsAt).toBe(c.input.decisionAtMs + 23 * HOUR_MS);
      expect(last.startsAt + HOUR_MS).toBeGreaterThanOrEqual(
        CHORES[c.input.chore].settleBounds(c.input.decisionAtMs).latestMs,
      );
      expect(c.input.toolHours[0]!.startsAt).toBeLessThanOrEqual(c.input.decisionAtMs);
      for (const hour of c.input.toolHours) {
        expect(hour.startsAt - 24 * HOUR_MS).toBeLessThan(c.input.decisionAtMs);
      }
    }
    // Plants decide at 19:00 and are checked up to 12:00 the next day: served through then.
    const plants = covered.find((c) => c.input.chore === "plants")!;
    expect(plants.input.toolHours.at(-1)!.startsAt).toBeGreaterThanOrEqual(
      madridWallTimeToEpochMs(plants.input.date, "19:00") + 17 * HOUR_MS,
    );
  });

  it("leaves out an hour that has no day-1 value instead of filling it from a fallback", async () => {
    const snapshot = await sliceSnapshot({ previousRunsNullDates: ["2026-09-02"] });
    const { cases } = buildCases(snapshot, RULES);
    const plants = cases.find((c) => c.input.chore === "plants" && c.input.date === "2026-09-01")!;
    const served = plants.input.toolHours.map((h) => h.startsAt);
    const midnight = madridWallTimeToEpochMs("2026-09-02", "00:00");
    expect(served.every((t) => t < midnight)).toBe(true);
    // The rule window does use the labelled fallback for those hours ...
    expect(plants.input.hours.some((h) => h.startsAt >= midnight)).toBe(true);
    expect(plants.input.forecast.quality).toBe("short_lead_forecast_optimistic");
    // ... and the tool never serves a value that is not day-1.
    for (const hour of plants.input.toolForecast.hours) {
      for (const value of Object.values(hour.values)) {
        expect(value.source).toBe("previous_runs_day1");
      }
    }
  });
});

describe("savings are credited inside the baseline's seasons (assumption in the report)", () => {
  const win = (chore: DecisionRecord["chore"], date: string): DecisionRecord => ({
    v: 1,
    strategy: "rule",
    chore,
    date,
    split: "holdout",
    action: "skip",
    basis: "rule",
    band: 4,
    ruleBand: 4,
    delivered: true,
    forecastQuality: "day1_previous_runs",
  });
  const context = { rules: RULES, catalogue: CATALOGUE, kind: "rule" as const };

  it("credits AC wins from 1 Jun to 30 Sep and heater wins from 1 Nov to 31 Mar, others always", () => {
    const summary = summarisePeriod(
      [
        win("ac", "2026-09-10"), // in season: 2.5 kWh
        win("ac", "2026-10-05"), // out of season: counted, not credited
        win("heater", "2026-10-05"), // out of season
        win("heater", "2026-11-02"), // in season: 3.5 kWh
        win("plants", "2026-10-05"), // always: 5 min, 4 L
      ],
      context,
    );
    expect(summary.skipsThatWorked).toBe(5);
    expect(summary.savings).toMatchObject({
      electricityKwh: 6,
      waterL: 4,
      timeSavedS: 300,
      winsOutsideSeason: { ac: 1, heater: 1 },
    });
  });

  it("states the baseline, the invented seasons and the skip threshold as assumptions in the report", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], () => undefined);
    const markdown = readFileSync(reportFile(out, "md"), "utf8");
    expect(markdown).toContain('from the "likely" band');
    expect(markdown).toContain("AC: 1 Jun to 30 Sep");
    expect(markdown).toContain("heater: 1 Nov to 31 Mar");
    expect(markdown).toContain("season dates are invented");
    expect(markdown).toContain("get_forecast serves the hours from the decision hour for 24 hours");
    const report = JSON.parse(readFileSync(reportFile(out, "json"), "utf8")) as BacktestReport;
    expect(report.method.assumptions.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Ollama: a short keep_alive, unloaded when a strategy finishes or the run pauses", () => {
  const configDir = (): string => configDirWith({ e4b: { tag: "gemma4:e4b" } });
  const args = (snapshotDir: string, out: string): string[] => [
    "--snapshot",
    snapshotDir,
    "--out",
    out,
    "--strategies",
    "e4b",
    "--splits",
    "holdout",
  ];

  it("sends keep_alive 5m and the seed with every call, then keep_alive 0 at the end", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const ollama = fakeOllama();
    const code = await backtestCommand(args(snapshotDir, tempDir()), () => undefined, {
      configDir: configDir(),
      fetch: ollama.fetch,
      env: {},
    });
    expect(code).toBe(0);
    const chats = ollama.requests.filter((r) => r.path === "/api/chat");
    const real = chats.filter((r) => (r.body?.messages?.length ?? 0) > 0);
    expect(real.length).toBeGreaterThan(10);
    expect(
      real.every((r) => r.body?.keep_alive === "5m" && r.body.options?.seed !== undefined),
    ).toBe(true);
    const loads = chats.filter((r) => r.body?.messages?.length === 0);
    expect(loads[0]?.body?.keep_alive).toBe("5m"); // the warm-up
    expect(chats.at(-1)?.body).toMatchObject({ messages: [], keep_alive: 0 });
  });

  it("unloads the model when the run pauses, so the morning settlements get the GPU", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const ollama = fakeOllama();
    let now = Date.UTC(2026, 9, 22, 4, 59, 50);
    const lines: string[] = [];
    const code = await backtestCommand(
      [...args(snapshotDir, tempDir()), "--pause-at", "07:00"],
      (l) => lines.push(l),
      {
        configDir: configDir(),
        fetch: ollama.fetch,
        env: {},
        now: () => {
          now += 3000;
          return now;
        },
      },
    );
    expect(code).toBe(3);
    expect(lines.some((l) => l.startsWith("Paused with"))).toBe(true);
    const chats = ollama.requests.filter((r) => r.path === "/api/chat");
    expect(chats.at(-1)?.body).toMatchObject({ messages: [], keep_alive: 0 });
  });
});

describe("nits", () => {
  it("writes performance.json apart so the reports stay byte-identical", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], () => undefined);
    expect(readdirSync(out)).toContain("performance.json");
    expect(JSON.parse(readFileSync(join(out, "performance.json"), "utf8"))).toHaveProperty(
      "e4b.jobs",
    );
    expect(readFileSync(reportFile(out, "json"), "utf8")).not.toContain("performance");
    expect(readFileSync(reportFile(out, "md"), "utf8")).not.toContain("Model time");
  });

  it("gives one-line errors, not stack traces, for a bad habits file or config", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const habits = join(tempDir(), "habits.json");
    writeFileSync(habits, "{nope");
    const lines: string[] = [];
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", tempDir(), ...FAKE, "--habits", habits],
      (l) => lines.push(l),
    );
    expect(code).toBe(1);
    expect(lines.find((l) => l.startsWith("Cannot"))).toMatch(
      /^Cannot read the habits file .*habits\.json: /,
    );
    expect(lines.join("\n")).not.toContain("    at ");

    const broken = configDirWith({});
    writeFileSync(join(broken, "rules.json"), "{");
    const more: string[] = [];
    expect(
      await backtestCommand(
        ["--snapshot", snapshotDir, "--out", tempDir(), ...FAKE],
        (l) => more.push(l),
        { configDir: broken },
      ),
    ).toBe(1);
    expect(more.find((l) => l.startsWith("Cannot"))).toMatch(/^Cannot read config\/rules\.json: /);

    const bad = tempDir();
    writeFileSync(join(bad, "snapshot.json"), "{}");
    const third: string[] = [];
    expect(
      await backtestCommand(["--snapshot", bad, "--out", tempDir(), ...FAKE], (l) => third.push(l)),
    ).toBe(1);
    expect(third.find((l) => l.startsWith("Cannot"))).toMatch(/^Cannot read the snapshot in /);
  });

  it("warns when the habits file looks like household data, and never prints its values", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const home = tempDir();
    const dir = join(home, ".should-i-bother");
    mkdirSync(dir);
    const habits = join(dir, "profile.json");
    writeFileSync(habits, JSON.stringify({ secret: "household-value-qq" }));
    const out = tempDir();
    const lines: string[] = [];
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, ...FAKE, "--habits", habits],
      (l) => lines.push(l),
      { homeDir: home },
    );
    expect(lines.some((l) => l.startsWith("WARNING:") && l.includes("household data"))).toBe(true);
    expect(lines.join("\n")).not.toContain("household-value-qq");
    for (const name of readdirSync(out)) {
      expect(readFileSync(join(out, name), "utf8")).not.toContain("household-value-qq");
    }
    // The same for a file called household.json anywhere.
    const named = join(tempDir(), "household.json");
    writeFileSync(named, "{}");
    const again: string[] = [];
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", tempDir(), ...FAKE, "--habits", named],
      (l) => again.push(l),
    );
    expect(again.some((l) => l.startsWith("WARNING:"))).toBe(true);
  });

  it("says when SIB_FAKE_MODEL=1 switches to the fake model, and documents exit codes in --help", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const lines: string[] = [];
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", tempDir(), "--strategies", "e4b"],
      (l) => lines.push(l),
      { env: { SIB_FAKE_MODEL: "1" } },
    );
    expect(lines[0]).toContain("SIB_FAKE_MODEL=1: the Gemma strategies run on recorded fixtures");
    const help: string[] = [];
    expect(await backtestCommand(["--help"], (l) => help.push(l))).toBe(0);
    expect(help.join("\n")).toMatch(/Exit codes:[\s\S]*3 {2}paused by --pause-at/);
  });

  it("reports a day without a sunset as no_sunset for the chores that need it", async () => {
    const snapshot = await sliceSnapshot();
    const sunsets = Object.fromEntries(
      Object.entries(snapshot.sunsetMsByDate).filter(([date]) => date !== "2026-09-02"),
    );
    const { skipped } = buildCases({ ...snapshot, sunsetMsByDate: sunsets }, RULES);
    expect(
      skipped
        .filter((s) => s.date === "2026-09-02" && s.reason === "no_sunset")
        .map((s) => s.chore)
        .sort(),
    ).toEqual(["laundry_line", "laundry_tonight"]);
  });

  it("shows the snapshot fetch time in Europe/Madrid and labels the fine-tuned in-sample rows correctly", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--fake-model", "--strategies", "e4b,e4b-ft"],
      () => undefined,
    );
    const markdown = readFileSync(reportFile(out, "md", ["e4b", "e4b-ft"]), "utf8");
    expect(markdown).toContain("Snapshot fetched 2026-10-22 11:00 Europe/Madrid");
    expect(markdown).not.toContain("trained on these days");
    expect(markdown).toContain("the 31 Aug overnight rows were not in training");
  });

  it("does not count safety-alert days as remaining Gemma calls in the estimate", async () => {
    const hot = await sliceSnapshot({
      forecastOverride: (_t, variable, value) =>
        variable === "temperature_2m" ? value + 20 : value,
    });
    const lines: string[] = [];
    const snapshotDir = await snapshotOnDisk(hot);
    await backtestCommand(
      [
        "--snapshot",
        snapshotDir,
        "--out",
        tempDir(),
        "--fake-model",
        "--strategies",
        "e4b",
        "--estimate-only",
      ],
      (l) => lines.push(l),
    );
    const cases = buildCases(hot, RULES).cases;
    const expected = cases.slice(3).filter((c) => c.input.alert === null).length;
    expect(cases.filter((c) => c.input.alert !== null).length).toBeGreaterThan(5);
    const estimate = lines.find((l) => l.startsWith("  Gemma 4 E4B (base):"));
    expect(estimate).toBeDefined();
    if (expected === 0) {
      expect(estimate).toContain("nothing left to run");
    } else {
      expect(estimate).toContain(`${expected} decisions`);
    }
  });
});
