import { describe, expect, it } from "vitest";

import { loadAdviceRules, parseAdviceRules } from "../src/server/advice-rules.js";
import { loadRules } from "../src/server/rules.js";

describe("AC-031.2: the advice rules are fixed values in config/advice-rules.json", () => {
  it("carries the numbers of the design table", () => {
    expect(loadAdviceRules()).toMatchObject({
      windowsClean: { rainMmAtLeast: 1, lookaheadHours: 48, settleHours: 6 },
      balconySweep: { gustKmhAtLeast: 40, lookaheadHours: 24, settleHours: 3 },
      outdoorPaint: { runHours: 24, humidityPctBelow: 85, tempCAtLeast: 10 },
      lawnFeed: { rainMmAtLeast: 10, lookaheadHours: 48 },
    });
  });

  it("uses the same wet hour as the rest of the rules, without touching rules.json", () => {
    expect(loadAdviceRules().wetHourMm).toBe(loadRules().wetHourMm);
  });

  it("refuses an unknown key or an out-of-range number", () => {
    const rules = { ...JSON.parse(JSON.stringify(loadAdviceRules())), version: 1 } as Record<
      string,
      unknown
    >;
    expect(() => parseAdviceRules({ ...rules, extra: 1 })).toThrow(/Invalid advice rules/);
    expect(() =>
      parseAdviceRules({
        ...rules,
        outdoorPaint: { runHours: 0, humidityPctBelow: 85, tempCAtLeast: 10 },
      }),
    ).toThrow(/Invalid advice rules/);
  });
});
