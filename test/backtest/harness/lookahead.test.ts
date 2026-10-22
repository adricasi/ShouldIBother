import { beforeAll, describe, expect, it } from "vitest";

import {
  DecisionTimeError,
  FixedRoutineStrategy,
  GemmaStrategy,
  MemoryDecisionStore,
  RuleStrategy,
  assertNoLookahead,
  backtestFakeModel,
  buildCases,
  runBacktest,
  type BacktestCase,
  type Strategy,
} from "../../../src/backtest/harness/index.js";
import { LookaheadError, type ForecastHour } from "../../../src/backtest/index.js";
import { HOUR_MS } from "../../../src/domain/outcomes.js";
import { RULES, sliceSnapshot } from "./support.js";

let cases: readonly BacktestCase[];
beforeAll(async () => {
  cases = buildCases(await sliceSnapshot(), RULES).cases;
});

const aCase = (): BacktestCase => cases.find((c) => c.input.chore === "plants")!;

/** The case with one forecast value pretending to come from a model run started at `issuedAtMs`. */
function withIssuedAt(c: BacktestCase, issuedAtMs: number): BacktestCase {
  const hours: ForecastHour[] = c.input.forecast.hours.map((hour, index) =>
    index === 2
      ? {
          ...hour,
          values: {
            ...hour.values,
            precipitation: { value: 0, source: "previous_runs_day1", issuedAtMs },
          },
        }
      : hour,
  );
  return { ...c, input: { ...c.input, forecast: { ...c.input.forecast, hours } } };
}

const strategies = (): Strategy[] => [
  new RuleStrategy(),
  new FixedRoutineStrategy(),
  new GemmaStrategy({ id: "e4b", model: backtestFakeModel("e4b"), rules: RULES }),
];

describe("AC-018.1: a lookahead test that fails when a decision uses a later model run", () => {
  it("accepts every case the harness builds", () => {
    for (const c of cases) {
      expect(() => assertNoLookahead(c.input)).not.toThrow();
    }
  });

  it("throws LookaheadError for a forecast value from a run that started at the decision time", () => {
    const c = aCase();
    expect(() => assertNoLookahead(withIssuedAt(c, c.input.decisionAtMs).input)).toThrow(
      LookaheadError,
    );
    expect(() => assertNoLookahead(withIssuedAt(c, c.input.decisionAtMs + HOUR_MS).input)).toThrow(
      LookaheadError,
    );
    expect(() => assertNoLookahead(withIssuedAt(c, c.input.decisionAtMs - 1).input)).not.toThrow();
  });

  it("throws when a decision is not at the chore's fixed time", () => {
    const c = aCase();
    expect(() =>
      assertNoLookahead({ ...c.input, decisionAtMs: c.input.decisionAtMs + HOUR_MS }),
    ).toThrow(DecisionTimeError);
  });

  it("stops the run before any strategy sees the tampered day, and records nothing for it", async () => {
    const c = aCase();
    const tampered = withIssuedAt(c, c.input.decisionAtMs + 1);
    const used = strategies();
    const store = new MemoryDecisionStore();
    await expect(
      runBacktest({ cases: [tampered], strategies: used, store, log: () => undefined }),
    ).rejects.toThrow(LookaheadError);
    expect(store.records()).toHaveLength(0);
    for (const s of used) {
      if (s instanceof GemmaStrategy) s.close();
    }
  });
});

describe("AC-018.1: decisions do not depend on anything after the decision time", () => {
  it("makes the same decisions when the recorded weather (the outcomes) is different", async () => {
    const run = async (archiveOverride?: (t: number, v: string, x: number) => number) => {
      const snapshot = await sliceSnapshot(
        archiveOverride === undefined ? {} : { archiveOverride },
      );
      const built = buildCases(snapshot, RULES);
      const used = strategies();
      const store = new MemoryDecisionStore();
      await runBacktest({ cases: built.cases, strategies: used, store, log: () => undefined });
      for (const s of used) {
        if (s instanceof GemmaStrategy) s.close();
      }
      return store.records();
    };
    const baseline = await run();
    // Rain everywhere and 10 degrees colder in the archive: every label may change, no forecast does.
    const stormy = await run((_t, variable, value) =>
      variable === "precipitation" ? value + 3 : variable === "temperature_2m" ? value - 10 : value,
    );
    const decisions = (records: typeof baseline) =>
      records.map(({ strategy, chore, date, action, basis, band }) => ({
        strategy,
        chore,
        date,
        action,
        basis,
        band,
      }));
    expect(decisions(stormy)).toEqual(decisions(baseline));
    // ... while the outcomes did change, so the comparison is not vacuous.
    expect(stormy.map((r) => r.delivered)).not.toEqual(baseline.map((r) => r.delivered));
  });

  it("makes different decisions when the day-1 forecast itself is different", async () => {
    const baseline = buildCases(await sliceSnapshot(), RULES).cases;
    const wetter = buildCases(
      await sliceSnapshot({
        forecastOverride: (_t, variable, value) =>
          variable === "precipitation" ? value + 3 : value,
      }),
      RULES,
    ).cases;
    expect(wetter.map((c) => c.input.ruleBand)).not.toEqual(baseline.map((c) => c.input.ruleBand));
  });
});
