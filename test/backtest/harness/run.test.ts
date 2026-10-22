import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BACKTEST_BUDGET_MS,
  FileDecisionStore,
  GemmaStrategy,
  FixedRoutineStrategy,
  MemoryDecisionStore,
  RuleStrategy,
  backtestFakeModel,
  backtestCommand,
  buildCases,
  estimateModel,
  parseDecisionLines,
  renderEstimate,
  runBacktest,
  type BacktestReport,
  type DecisionRecord,
  type StrategyId,
} from "../../../src/backtest/harness/index.js";
import { FakeModelClient } from "../../../src/server/model/fake.js";
import { FOUR, RULES, reportFile, sliceSnapshot, snapshotOnDisk, tempDir } from "./support.js";

const FAKE = ["--fake-model", "--strategies", "rule,fixed,e2b,e4b"];

async function setup(): Promise<{ snapshotDir: string; out: string }> {
  return { snapshotDir: await snapshotOnDisk(await sliceSnapshot()), out: tempDir() };
}

/** The decisions without the measured wall-clock time, which differs between runs. */
function decisionLines(dir: string): string[] {
  return readFileSync(join(dir, "decisions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.replace(/"latencyMs":\d+/, '"latencyMs":0'));
}

function readReport(
  out: string,
  ids: readonly StrategyId[] = FOUR,
  splits: "all" | "train" | "holdout" = "all",
): BacktestReport {
  return JSON.parse(readFileSync(reportFile(out, "json", ids, splits), "utf8")) as BacktestReport;
}

describe("T-015 done-when: sib backtest runs end to end on the fake model on a 2-week slice", () => {
  it("AC-018.3: reports every strategy with skips, skips that worked, savings, plant-risk days, calibration, Brier and tool-call miss rate", async () => {
    const { snapshotDir, out } = await setup();
    const lines: string[] = [];
    const code = await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], (line) =>
      lines.push(line),
    );
    expect(code).toBe(0);

    const report = readReport(out);
    expect(report.status).toBe("complete");
    expect(report.results.map((r) => r.id)).toEqual(["rule", "fixed", "e2b", "e4b"]);
    for (const result of report.results) {
      for (const period of [result.holdout, result.inSample]) {
        expect(period).not.toBeNull();
        expect(period).toMatchObject({
          skips: expect.any(Number) as number,
          skipsThatWorked: expect.any(Number) as number,
          plantRiskDays: expect.any(Number) as number,
        });
        expect(period?.savings).toMatchObject({
          waterL: expect.any(Number) as number,
          electricityKwh: expect.any(Number) as number,
          timeSavedS: expect.any(Number) as number,
        });
      }
    }
    const e4b = report.results.find((r) => r.id === "e4b")!;
    expect(e4b.holdout?.calibration).toMatchObject({ status: "ok" });
    if (e4b.holdout?.calibration.status === "ok") {
      expect(e4b.holdout.calibration.bands).toHaveLength(5);
      expect(e4b.holdout.calibration.bands.every((b) => typeof b.n === "number")).toBe(true);
      expect(e4b.holdout.calibration.brier).toEqual(expect.any(Number));
    }
    expect(e4b.holdout?.toolCalls).toMatchObject({ firstAnswerMissRate: 0 });
    expect(report.fakeModel).toBe(true);

    const markdown = readFileSync(reportFile(out, "md"), "utf8");
    expect(markdown).toContain("FAKE MODEL");
    expect(markdown).toContain("Brier score");
    expect(markdown).toContain("Tool-call miss rate");
  });

  it("AC-018.3: the fixed routine's calibration is n/a, in the JSON and in the Markdown", async () => {
    const { snapshotDir, out } = await setup();
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], () => undefined);
    const fixed = readReport(out).results.find((r) => r.id === "fixed")!;
    expect(fixed.holdout?.calibration.status).toBe("n/a");
    expect(fixed.inSample?.calibration.status).toBe("n/a");
    expect(readFileSync(reportFile(out, "md"), "utf8")).toContain(
      "**Fixed routine**: calibration n/a.",
    );
  });

  it("AC-018.3: the in-sample / hold-out split is visible in the report (Markdown and JSON)", async () => {
    const { snapshotDir, out } = await setup();
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], () => undefined);
    const report = readReport(out);
    expect(report.headline).toBe("holdout");
    expect(report.periods.holdout).toMatchObject({ from: "2026-09-01" });
    expect(report.periods.inSample).toMatchObject({ to: "2026-08-31" });
    const markdown = readFileSync(reportFile(out, "md"), "utf8");
    expect(markdown).toMatch(/## Headline: hold-out, 2026-09-01 to 2026-09-06/);
    expect(markdown).toMatch(/## In-sample \(2026-08-24 to 2026-08-31\)/);
    expect(markdown).toContain("In-sample, not a fair test");
    // The hold-out is first.
    expect(markdown.indexOf("## Headline")).toBeLessThan(markdown.indexOf("## In-sample"));
  });

  it("T-019 done-when: the report lists the rules.json values and the model settings used", async () => {
    const { snapshotDir, out } = await setup();
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], () => undefined);
    const report = readReport(out);
    expect(report.method.rules.bandOdds).toEqual([15, 35, 50, 70, 85]);
    expect(report.method.rulesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.method.model.seed).toEqual(expect.any(Number));
    expect(readFileSync(reportFile(out, "md"), "utf8")).toContain('"rainMmAtLeast": 5');
  });

  it("NFR-012: a fresh re-run gives the same decisions and the same reported numbers", async () => {
    const { snapshotDir } = await setup();
    const first = tempDir();
    const second = tempDir();
    for (const out of [first, second]) {
      await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], () => undefined);
    }
    expect(decisionLines(second)).toEqual(decisionLines(first));
    expect(readFileSync(reportFile(second, "json"), "utf8")).toBe(
      readFileSync(reportFile(first, "json"), "utf8"),
    );
    expect(readFileSync(reportFile(second, "md"), "utf8")).toBe(
      readFileSync(reportFile(first, "md"), "utf8"),
    );
  });

  it("AC-019.3 (harness): the fine-tuned model can be run on the hold-out only", async () => {
    const { snapshotDir, out } = await setup();
    const code = await backtestCommand(
      [
        "--snapshot",
        snapshotDir,
        "--out",
        out,
        "--fake-model",
        "--strategies",
        "e4b,e4b-ft",
        "--splits",
        "holdout",
      ],
      () => undefined,
    );
    expect(code).toBe(0);
    const report = readReport(out, ["e4b", "e4b-ft"], "holdout");
    expect(report.results.map((r) => r.id)).toEqual(["e4b", "e4b-ft"]);
    for (const result of report.results) {
      expect(result.holdout).not.toBeNull();
      expect(result.inSample).toBeNull();
    }
  });
});

describe("NFR-005: resumable, progress output, --pause-at", () => {
  it("prints progress lines for each Gemma model", async () => {
    const { snapshotDir, out } = await setup();
    const lines: string[] = [];
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, ...FAKE],
      (l) => lines.push(l),
      {
        progressEvery: 10,
      },
    );
    const progress = lines.filter((l) => /^\[Gemma 4 E4B \(base\)\] \d+\/\d+ \(\d+%\)/.test(l));
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toMatch(/\(100%\)/);
  });

  it("prints the estimate per model before the long part starts", async () => {
    const { snapshotDir, out } = await setup();
    const lines: string[] = [];
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], (l) => lines.push(l));
    const estimate = lines.findIndex((l) => l.startsWith("Estimate"));
    const e2b = lines.findIndex((l) => l.startsWith("  Gemma 4 E2B:") && l.includes("calls"));
    const e4b = lines.findIndex(
      (l) => l.startsWith("  Gemma 4 E4B (base):") && l.includes("calls"),
    );
    const firstProgress = lines.findIndex((l) => /^\[Gemma 4 E2B\] \d+ decisions to go/.test(l));
    expect(estimate).toBeGreaterThan(-1);
    expect(e2b).toBeGreaterThan(estimate);
    expect(e4b).toBeGreaterThan(estimate);
    expect(firstProgress).toBeGreaterThan(e4b);
    expect(lines.some((l) => l.includes("budget (NFR-005)"))).toBe(true);
  });

  it("--estimate-only measures a few decisions, prints the estimate and writes no report", async () => {
    const { snapshotDir, out } = await setup();
    const lines: string[] = [];
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, ...FAKE, "--estimate-only"],
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("Estimate"))).toBe(true);
    expect(existsSync(reportFile(out, "md"))).toBe(false);
    // Only the measuring decisions were made: 3 per model.
    expect(parseDecisionLines(readFileSync(join(out, "decisions.jsonl"), "utf8"))).toHaveLength(6);
  });

  it("--pause-at stops between decisions at that Madrid time and a second run resumes to the same result", async () => {
    const { snapshotDir, out } = await setup();
    // The clock starts at 06:59:50 Madrid time on 22 Oct and moves 4 s per reading.
    let now = Date.UTC(2026, 9, 22, 4, 59, 50);
    const clock = (): number => {
      now += 4000;
      return now;
    };
    const lines: string[] = [];
    const first = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, ...FAKE, "--pause-at", "07:00"],
      (l) => lines.push(l),
      { now: clock },
    );
    expect(first).toBe(3);
    expect(lines.some((l) => l.includes("paused"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Paused with"))).toBe(true);
    expect(readReport(out).status).toBe("partial");
    expect(readFileSync(reportFile(out, "md"), "utf8")).toContain("PARTIAL");
    const done = parseDecisionLines(readFileSync(join(out, "decisions.jsonl"), "utf8")).length;

    const resumed: string[] = [];
    const second = await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...FAKE], (l) =>
      resumed.push(l),
    );
    expect(second).toBe(0);
    expect(resumed.some((l) => l.startsWith(`Resuming ${out}: ${done} decisions`))).toBe(true);
    expect(readReport(out).status).toBe("complete");

    const straight = tempDir();
    await backtestCommand(["--snapshot", snapshotDir, "--out", straight, ...FAKE], () => undefined);
    expect(readFileSync(reportFile(out, "json"), "utf8")).toBe(
      readFileSync(reportFile(straight, "json"), "utf8"),
    );
    expect(decisionLines(out).sort()).toEqual(decisionLines(straight).sort());
  });

  it("never stops in the middle of a decision: a paused run has only whole decisions on disk", async () => {
    const cases = buildCases(await sliceSnapshot(), RULES).cases;
    const store = new MemoryDecisionStore();
    const strategy = new GemmaStrategy({
      id: "e4b",
      model: backtestFakeModel("e4b"),
      rules: RULES,
    });
    let readings = 0;
    const outcome = await runBacktest({
      cases,
      strategies: [new RuleStrategy(), new FixedRoutineStrategy(), strategy],
      store,
      log: () => undefined,
      probe: 1,
      now: () => 1000 * ++readings,
      pauseAtMs: 20_000,
    });
    strategy.close();
    expect(outcome.status).toBe("paused");
    expect(outcome.remaining).toBeGreaterThan(0);
    for (const record of store.records()) {
      expect(record.delivered).toEqual(expect.any(Boolean));
    }
  });

  it("tolerates a decision cut off by a crash and makes it again", async () => {
    const { snapshotDir, out } = await setup();
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--fake-model", "--strategies", "rule"],
      () => undefined,
    );
    const path = join(out, "decisions.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${lines.slice(0, -3).join("\n")}\n${lines.at(-2)!.slice(0, 40)}`);
    const store = FileDecisionStore.open(out);
    expect(store.records()).toHaveLength(lines.length - 3);
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--fake-model", "--strategies", "rule"],
      () => undefined,
    );
    expect(decisionLines(out).sort()).toEqual(lines.sort());
  });

  it("refuses a damaged line that is not the last one", () => {
    const good = JSON.stringify({ v: 1 });
    expect(() => parseDecisionLines(`not json\n${good}\n`)).toThrow(/line 1/);
  });

  it("refuses to resume a run made with other inputs, and --restart starts over", async () => {
    const { snapshotDir, out } = await setup();
    const habits = join(tempDir(), "habits.json");
    writeFileSync(habits, JSON.stringify({ marker: "habit-value-xyz" }));
    await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--fake-model", "--strategies", "rule"],
      () => undefined,
    );
    const lines: string[] = [];
    const code = await backtestCommand(
      [
        "--snapshot",
        snapshotDir,
        "--out",
        out,
        "--fake-model",
        "--strategies",
        "rule",
        "--habits",
        habits,
      ],
      (l) => lines.push(l),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/different habits.*--restart/s);
    const restarted = await backtestCommand(
      [
        "--snapshot",
        snapshotDir,
        "--out",
        out,
        "--fake-model",
        "--strategies",
        "rule",
        "--habits",
        habits,
        "--restart",
      ],
      () => undefined,
    );
    expect(restarted).toBe(0);
    const method = readReport(out, ["rule"]).method;
    // The values never reach a file: only their count and hash.
    expect(method.habits).toEqual({
      entries: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    for (const name of readdirSync(out)) {
      expect(readFileSync(join(out, name), "utf8")).not.toContain("habit-value-xyz");
    }
    expect(method.habits.entries).toBe(1);
  });

  it("stops with exit code 2 when Gemma goes offline, keeps the progress and resumes later", async () => {
    const { snapshotDir, out } = await setup();
    const scripted = new FakeModelClient({ scenario: () => "offline" });
    const lines: string[] = [];
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--strategies", "rule,e4b"],
      (l) => lines.push(l),
      { createModel: () => Promise.resolve(scripted), sleep: () => Promise.resolve() },
    );
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/Gemma is not reachable/);
    const rows = parseDecisionLines(readFileSync(join(out, "decisions.jsonl"), "utf8"));
    expect(rows.every((r) => r.strategy === "rule")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);

    const resumed = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--strategies", "rule,e4b"],
      () => undefined,
      { createModel: () => Promise.resolve(backtestFakeModel("e4b")) },
    );
    expect(resumed).toBe(0);
  });
});

describe("usage and configuration errors", () => {
  it("asks for a model tag, and names --fake-model, instead of silently using the fake", async () => {
    const { snapshotDir, out } = await setup();
    const lines: string[] = [];
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--strategies", "e4b"],
      (l) => lines.push(l),
      { env: {} },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("config/models.json has no models.e4b.tag");
    expect(lines.join("\n")).toContain("--fake-model");
  });

  it("rejects unknown strategies, bad times and dates", async () => {
    for (const args of [
      ["--strategies", "gpt"],
      ["--pause-at", "7am"],
      ["--splits", "some"],
      ["--from", "yesterday"],
      ["--bogus"],
    ]) {
      const lines: string[] = [];
      expect(await backtestCommand(args, (l) => lines.push(l), { env: {} })).toBe(1);
      expect(lines.join("\n")).toContain("Usage: sib backtest");
    }
  });

  it("explains when there is no snapshot", async () => {
    const lines: string[] = [];
    const code = await backtestCommand([], (l) => lines.push(l), { cwd: tempDir(), env: {} });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("No snapshot found in data-snapshots/");
  });
});

describe("NFR-005: the estimate is calls x measured latency per model", () => {
  const job = (calls: number, latencyMs: number): DecisionRecord => ({
    v: 1,
    strategy: "e4b",
    chore: "plants",
    date: "2026-09-01",
    split: "holdout",
    action: "skip",
    basis: "gemma",
    band: 3,
    ruleBand: 3,
    delivered: true,
    forecastQuality: "day1_previous_runs",
    gemma: {
      model: "m",
      modelDigest: null,
      promptVersion: "bookmaker.v1",
      toolMode: "called",
      firstAnswerWithoutTool: false,
      calls,
      retries: 0,
      latencyMs,
      failure: null,
      gemmaBand: 3,
      bandsFromRule: 0,
    },
  });

  it("multiplies the decisions to go by the measured calls per decision and time per call", () => {
    const estimate = estimateModel(
      "e4b",
      "Gemma 4 E4B (base)",
      [job(2, 12_000), job(2, 12_000)],
      100,
    );
    expect(estimate).toMatchObject({ callsPerDecision: 2, msPerCall: 6000, expectedMs: 1_200_000 });
    expect(estimate.worstCaseMs).toBe(100 * 4 * 6000);
    const lines = renderEstimate([estimate]);
    expect(lines.join("\n")).toContain("100 decisions x 2 calls x 6.0 s = 20 min");
    expect(lines.join("\n")).toContain("40 min");
  });

  it("warns when the expected time is over the 8 hour budget", () => {
    const estimate = estimateModel("e4b", "Gemma 4 E4B (base)", [job(2, 20_000)], 2000);
    expect(estimate.expectedMs).toBeGreaterThan(BACKTEST_BUDGET_MS);
    expect(renderEstimate([estimate]).join("\n")).toContain("WARNING");
  });
});
