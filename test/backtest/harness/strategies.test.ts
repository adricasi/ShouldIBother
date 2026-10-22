import { describe, expect, it } from "vitest";

import {
  FixedRoutineStrategy,
  RuleStrategy,
  SKIP_FROM_BAND,
  actionForBand,
  buildCases,
  fixedRoutineAction,
} from "../../../src/backtest/harness/index.js";
import { RULES, sliceSnapshot } from "./support.js";

describe("the fixed routine (the habit baseline)", () => {
  it("waters every other day, tumble dries and brings the laundry in every time", () => {
    expect(fixedRoutineAction("plants", "2026-04-01")).toBe("do_it");
    expect(fixedRoutineAction("plants", "2026-04-02")).toBe("skip");
    expect(fixedRoutineAction("plants", "2026-04-03")).toBe("do_it");
    expect(fixedRoutineAction("laundry_line", "2026-07-15")).toBe("do_it");
    expect(fixedRoutineAction("laundry_tonight", "2026-07-15")).toBe("do_it");
  });

  it("runs the AC on summer evenings and the heater in winter only", () => {
    expect(fixedRoutineAction("ac", "2026-05-31")).toBe("skip");
    expect(fixedRoutineAction("ac", "2026-06-01")).toBe("do_it");
    expect(fixedRoutineAction("ac", "2026-09-30")).toBe("do_it");
    expect(fixedRoutineAction("ac", "2026-10-01")).toBe("skip");
    expect(fixedRoutineAction("heater", "2026-10-31")).toBe("skip");
    expect(fixedRoutineAction("heater", "2026-11-01")).toBe("do_it");
  });

  it("never reads a forecast and has no odds", async () => {
    const { cases } = buildCases(await sliceSnapshot(), RULES);
    const decision = await new FixedRoutineStrategy().decide(cases[0]!.input);
    expect(decision).toMatchObject({ basis: "fixed_routine", band: null });
  });
});

describe("the rule strategy", () => {
  it("bets on doing nothing from 'likely' (70 %) up and prices every day with the rule band", async () => {
    expect(SKIP_FROM_BAND).toBe(3);
    expect(actionForBand(2)).toBe("do_it");
    expect(actionForBand(3)).toBe("skip");
    const { cases } = buildCases(await sliceSnapshot(), RULES);
    for (const c of cases.filter((x) => x.input.alert === null)) {
      const decision = await new RuleStrategy().decide(c.input);
      expect(decision).toMatchObject({ basis: "rule", band: c.input.ruleBand });
      expect(decision.action).toBe(actionForBand(c.input.ruleBand));
    }
  });

  it("AC-012.1: a heat day is a 'Do it now' alert, never a skip, whatever the band", async () => {
    const hot = await sliceSnapshot({
      forecastOverride: (_t, variable, value) =>
        variable === "temperature_2m" ? value + 20 : value,
    });
    const { cases } = buildCases(hot, RULES);
    const alerts = cases.filter((c) => c.input.alert !== null);
    expect(alerts.length).toBeGreaterThan(10);
    for (const c of alerts) {
      expect(await new RuleStrategy().decide(c.input)).toEqual({
        action: "do_it",
        basis: "safety_alert",
        band: null,
      });
    }
  });
});
