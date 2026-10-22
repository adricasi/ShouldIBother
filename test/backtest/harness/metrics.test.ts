import { describe, expect, it } from "vitest";

import {
  MIN_BAND_N,
  summarisePeriod,
  type DecisionRecord,
  type GemmaFacts,
} from "../../../src/backtest/harness/index.js";
import type { OutcomeChore } from "../../../src/domain/outcomes.js";
import type { Band } from "../../../src/domain/bands.js";
import { CATALOGUE, RULES } from "./support.js";

let counter = 0;
function record(over: Partial<DecisionRecord> & { chore?: OutcomeChore } = {}): DecisionRecord {
  counter += 1;
  return {
    v: 1,
    strategy: "rule",
    chore: "plants",
    date: `2026-09-${String((counter % 28) + 1).padStart(2, "0")}`,
    split: "holdout",
    action: "skip",
    basis: "rule",
    band: 3,
    ruleBand: 3,
    delivered: true,
    forecastQuality: "day1_previous_runs",
    ...over,
  };
}

const facts = (over: Partial<GemmaFacts> = {}): GemmaFacts => ({
  model: "m",
  modelDigest: null,
  promptVersion: "bookmaker.v1",
  toolMode: "called",
  firstAnswerWithoutTool: false,
  calls: 2,
  retries: 0,
  latencyMs: 10,
  failure: null,
  gemmaBand: 3,
  bandsFromRule: 0,
  ...over,
});

const ruleContext = { rules: RULES, catalogue: CATALOGUE, kind: "rule" as const };

describe("AC-018.3: skips, skips that worked, savings and plant-risk days", () => {
  it("counts skips, the ones that worked, and plant-risk days (skipped watering, label false)", () => {
    const summary = summarisePeriod(
      [
        record({ chore: "plants", action: "skip", delivered: true }),
        record({ chore: "plants", action: "skip", delivered: false }),
        record({ chore: "plants", action: "do_it", delivered: false, band: 1 }),
        record({ chore: "ac", action: "skip", delivered: false }),
      ],
      ruleContext,
    );
    expect(summary).toMatchObject({ decisions: 4, skips: 3, skipsThatWorked: 1, doIts: 1 });
    // An AC skip that failed is not a plant-risk day; only skipped watering with a false label.
    expect(summary.plantRiskDays).toBe(1);
    expect(summary.byChore.plants).toEqual({
      decisions: 3,
      skips: 2,
      skipsThatWorked: 1,
      plantRiskDays: 1,
    });
  });

  it("counts savings only on skips that worked, time only for skipped steps (REQ-011)", () => {
    const summary = summarisePeriod(
      [
        record({ chore: "plants", delivered: true }), // 5 min, 4 L
        record({ chore: "plants", delivered: false }), // a loss saves nothing
        record({ chore: "laundry_line", delivered: true }), // heat-pump dryer: 2.2 kWh, 0 min
        record({ chore: "ac", action: "do_it", band: 1, delivered: true }), // a do-it saves nothing
      ],
      ruleContext,
    );
    expect(summary.savings).toMatchObject({
      timeSavedS: 5 * 60,
      waterL: 4,
      electricityKwh: 2.2,
    });
    expect(summary.savings.assumptions.map((a) => a.chore).sort()).toEqual([
      "laundry_line",
      "plants",
    ]);
  });

  it("subtracts 30 s per bet or do-it decision made in the app, but not for safety alerts", () => {
    const summary = summarisePeriod(
      [
        record({ chore: "plants", delivered: true }),
        record({ chore: "ac", action: "do_it", band: 1 }),
        record({ chore: "heater", action: "do_it", basis: "safety_alert", band: null }),
      ],
      ruleContext,
    );
    expect(summary.savings.appTimeS).toBe(60);
    expect(summary.savings.netTimeS).toBe(5 * 60 - 60);
    expect(summary.safetyAlerts).toBe(1);
  });

  it("charges the fixed routine no app time", () => {
    const summary = summarisePeriod(
      [record({ strategy: "fixed", basis: "fixed_routine", band: null, delivered: true })],
      { ...ruleContext, kind: "fixed" },
    );
    expect(summary.savings.appTimeS).toBe(0);
    expect(summary.savings.netTimeS).toBe(summary.savings.timeSavedS);
  });
});

describe("AC-018.3: calibration with N per band, Brier score", () => {
  it("reports the fixed routine's calibration as n/a", () => {
    const summary = summarisePeriod(
      [record({ strategy: "fixed", basis: "fixed_routine", band: null })],
      { ...ruleContext, kind: "fixed" },
    );
    expect(summary.calibration.status).toBe("n/a");
  });

  it("reports N, share and 'too few to judge' per band, and the Brier score", () => {
    const records = [
      ...Array.from({ length: 5 }, (_, i) => record({ band: 4, ruleBand: 4, delivered: i < 4 })),
      record({ band: 0, ruleBand: 0, delivered: false }),
      record({ band: 0, ruleBand: 0, delivered: true }),
    ];
    const summary = summarisePeriod(records, ruleContext);
    if (summary.calibration.status !== "ok") throw new Error("expected calibration");
    const byBand = (band: Band) =>
      summary.calibration.status === "ok" ? summary.calibration.bands[band]! : undefined;
    expect(byBand(4)).toMatchObject({
      n: 5,
      worked: 4,
      share: 0.8,
      odds: 85,
      tooFewToJudge: false,
    });
    expect(byBand(0)).toMatchObject({ n: 2, worked: 1, share: 0.5, odds: 15, tooFewToJudge: true });
    expect(byBand(2)).toMatchObject({ n: 0, share: null, tooFewToJudge: true });
    expect(MIN_BAND_N).toBe(5);
    expect(summary.calibration.n).toBe(7);
    // (0.85-1)^2 x 4 + (0.85-0)^2 + (0.15-0)^2 + (0.15-1)^2, over 7
    const expected = (4 * 0.0225 + 0.7225 + 0.0225 + 0.7225) / 7;
    expect(summary.calibration.brier).toBeCloseTo(expected, 4);
  });

  it("leaves rule-odds days and alerts out of Gemma's calibration and says how many fell back", () => {
    const gemma = (over: Partial<DecisionRecord>) =>
      record({ strategy: "e4b", gemma: facts(), ...over });
    const summary = summarisePeriod(
      [
        gemma({ basis: "gemma", band: 4, ruleBand: 2, delivered: true }),
        gemma({
          basis: "rule_fallback",
          band: 2,
          ruleBand: 2,
          delivered: false,
          gemma: facts({
            failure: "tool_missed",
            toolMode: "missed",
            firstAnswerWithoutTool: true,
          }),
        }),
        gemma({ basis: "safety_alert", band: null, action: "do_it" }),
      ],
      { ...ruleContext, kind: "gemma" },
    );
    if (summary.calibration.status !== "ok") throw new Error("expected calibration");
    expect(summary.calibration.n).toBe(1);
    expect(summary.ruleFallbacks).toEqual({ tool_missed: 1 });
    // The rule's Brier on the one day Gemma priced: band 2 = 50 %, outcome true.
    expect(summary.calibration.ruleBrierOnSameCases).toBe(0.25);
    expect(summary.calibration.brier).toBe(0.0225);
  });
});

describe("AC-019.3 (harness): tool-call miss rate", () => {
  it("counts first answers without the call and misses that survive the retry; injected is separate", () => {
    const job = (over: Partial<GemmaFacts>) =>
      record({ strategy: "e4b", basis: "gemma", gemma: facts(over) });
    const summary = summarisePeriod(
      [
        job({}),
        job({}),
        job({ firstAnswerWithoutTool: true, toolMode: "called", retries: 1 }),
        job({ firstAnswerWithoutTool: true, toolMode: "missed", failure: "tool_missed" }),
      ],
      { ...ruleContext, kind: "gemma" },
    );
    expect(summary.toolCalls).toEqual({
      jobs: 4,
      firstAnswerWithoutTool: 2,
      missedAfterRetry: 1,
      injected: 0,
      firstAnswerMissRate: 0.5,
      missedAfterRetryRate: 0.25,
    });
    const injected = summarisePeriod(
      [
        record({
          strategy: "e4b",
          basis: "gemma",
          gemma: facts({ toolMode: "injected", firstAnswerWithoutTool: null }),
        }),
      ],
      { ...ruleContext, kind: "gemma" },
    );
    expect(injected.toolCalls).toMatchObject({
      injected: 1,
      firstAnswerMissRate: null,
      missedAfterRetryRate: null,
    });
  });
});
