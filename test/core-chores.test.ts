import { describe, expect, it } from "vitest";

import { CHORES } from "../src/domain/chores.js";
import { DRYER_TYPES, snapshotFor } from "../src/domain/savings.js";
import { madridWallTimeToEpochMs } from "../src/domain/time.js";
import { loadSavings } from "../src/server/savings.js";

const MORNING = madridWallTimeToEpochMs("2026-10-22", "09:00");

describe("AC-016.1: do-nothing bets for water balcony plants and line-dry today, with catalogue savings and settle-time rules", () => {
  const CORE = ["plants", "laundry_line"] as const;

  it("both chores have a title, the three one-tap answers and a rule window", () => {
    expect(CHORES.plants.title).toBe("Water plants");
    expect(CHORES.laundry_line.title).toBe("Line-dry today (skip the dryer)");
    for (const chore of CORE) {
      expect(CHORES[chore].tapAnswers).toHaveLength(3);
      const window = CHORES[chore].ruleWindow(MORNING);
      expect(window.toMs).toBeGreaterThan(window.fromMs);
    }
  });

  it("plants settle the next day between 08:00 and 12:00, line-drying the same day between 18:00 and 21:00 (Madrid)", () => {
    expect(CHORES.plants.settleBounds(MORNING)).toEqual({
      earliestMs: madridWallTimeToEpochMs("2026-10-23", "08:00"),
      latestMs: madridWallTimeToEpochMs("2026-10-23", "12:00"),
    });
    expect(CHORES.laundry_line.settleBounds(MORNING)).toEqual({
      earliestMs: madridWallTimeToEpochMs("2026-10-22", "18:00"),
      latestMs: madridWallTimeToEpochMs("2026-10-22", "21:00"),
    });
    // The rule's own settle time is the earliest bound of each.
    expect(CHORES.plants.ruleSettleAt(MORNING)).toBe(
      CHORES.plants.settleBounds(MORNING).earliestMs,
    );
    expect(CHORES.laundry_line.ruleSettleAt(MORNING)).toBe(
      CHORES.laundry_line.settleBounds(MORNING).earliestMs,
    );
  });

  it("each has catalogue savings with an assumption and where it comes from, for every dryer a household can have", () => {
    const catalogue = loadSavings();
    for (const dryer of DRYER_TYPES) {
      for (const chore of CORE) {
        const figure = snapshotFor(catalogue, chore, { dryer });
        expect(figure.assumption.length, `${chore} ${dryer}`).toBeGreaterThan(0);
        expect(["sourced", "typical estimate", "household baseline"]).toContain(figure.basis);
        expect(figure.time_min).toBeGreaterThanOrEqual(0);
      }
    }
    // Plants save time and water; line-drying saves the dryer's electricity and no minutes (AC-011.4).
    const plants = snapshotFor(catalogue, "plants", { dryer: "heat-pump" });
    expect(plants.time_min).toBeGreaterThan(0);
    expect(plants.water_l).toBeGreaterThan(0);
    const line = snapshotFor(catalogue, "laundry_line", { dryer: "heat-pump" });
    expect(line.time_min).toBe(0);
    expect(line.electricity_kwh).toBeGreaterThan(0);
  });
});
