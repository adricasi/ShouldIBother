import { describe, expect, it } from "vitest";

import {
  CHORES,
  CHORE_TYPES,
  clampSettleAt,
  describeNextOffer,
  isChoreType,
  offerNotice,
  type ChoreType,
} from "../src/domain/chores.js";
import { madridParts, madridWallTime, nextMadridWallTime } from "../src/domain/time.js";
import { forecastAgeLabel } from "../src/domain/weather.js";

const MINUTE = 60_000;
/** A Madrid wall-clock instant on a given day of October 2026 (UTC+2 until 25 Oct 03:00). */
const madrid = (day: number, hour: number, minute = 0): number =>
  madridWallTime(Date.UTC(2026, 9, day, 12), 0, hour, minute);

function madridClock(epochMs: number): string {
  const p = madridParts(epochMs);
  return `${p.day}/${p.month} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

describe("chore types (design.md, Gemma jobs: listener enum)", () => {
  it("include plants, laundry_line, laundry_tonight, ac and heater", () => {
    expect([...CHORE_TYPES]).toEqual(["plants", "laundry_line", "laundry_tonight", "ac", "heater"]);
    expect(isChoreType("laundry_line")).toBe(true);
    expect(isChoreType("laundry_plan")).toBe(false);
    expect(isChoreType("not_weather")).toBe(false);
  });

  it("every chore has a title, a judge name and tap answers with unique ids", () => {
    const ids = CHORE_TYPES.flatMap((type) => CHORES[type].tapAnswers.map((answer) => answer.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const type of CHORE_TYPES) {
      expect(CHORES[type].title.length).toBeGreaterThan(0);
      expect(CHORES[type].tapAnswers.length).toBeGreaterThanOrEqual(2);
    }
    expect(CHORES.laundry_line.title).toBe("Line-dry today (skip the dryer)");
  });
});

describe("AC-016.4: line-dry today is offered from 07:00 to 15:00 Madrid time", () => {
  const offer = (epochMs: number) => CHORES.laundry_line.offer?.(epochMs);

  it.each([
    ["06:59", madrid(22, 6, 59), false],
    ["07:00 (lower bound included)", madrid(22, 7), true],
    ["14:59", madrid(22, 14, 59), true],
    ["15:00 (upper bound excluded)", madrid(22, 15), false],
    ["23:30", madrid(22, 23, 30), false],
    ["00:30", madrid(23, 0, 30), false],
  ])("%s", (_name, now, offered) => {
    expect(offer(now)?.offered).toBe(offered);
  });

  it("says when it can be offered next: today before 07:00, tomorrow after 15:00", () => {
    const early = offer(madrid(22, 5));
    expect(early).toMatchObject({ offered: false, nextAtMs: madrid(22, 7) });
    const late = offer(madrid(22, 16));
    expect(late).toMatchObject({ offered: false, nextAtMs: madrid(23, 7) });
    expect(describeNextOffer(madrid(22, 5), madrid(22, 7))).toBe("today at 07:00");
    expect(describeNextOffer(madrid(22, 16), madrid(23, 7))).toBe("tomorrow at 07:00");
    expect(offerNotice("laundry_line", madrid(22, 16), madrid(23, 7))).toBe(
      "Line-dry today (skip the dryer) is offered from 07:00 to 15:00. Next chance: tomorrow at 07:00.",
    );
  });

  it("follows Madrid's clock, also on the day the clocks change (25 Oct 2026)", () => {
    const sevenCet = Date.UTC(2026, 9, 25, 6, 0); // 07:00 CET after the change
    expect(offer(sevenCet)?.offered).toBe(true);
    expect(offer(sevenCet - MINUTE)?.offered).toBe(false); // 06:59 CET
    expect(offer(Date.UTC(2026, 9, 25, 14, 0))?.offered).toBe(false); // 15:00 CET
    expect(offer(Date.UTC(2026, 9, 25, 13, 59))?.offered).toBe(true);
  });

  it("other chores have no time-of-day gate", () => {
    expect(CHORES.plants.offer).toBeUndefined();
    expect(CHORES.heater.offer).toBeUndefined();
  });
});

describe("rule windows and settle times (design.md, Settle-time bounds)", () => {
  it("plants: now to 08:00 the next day, settling there (bounds 08:00 to 12:00)", () => {
    const now = madrid(22, 19);
    expect(CHORES.plants.ruleWindow(now)).toEqual({ fromMs: now, toMs: madrid(23, 8) });
    expect(CHORES.plants.settleBounds(now)).toEqual({
      earliestMs: madrid(23, 8),
      latestMs: madrid(23, 12),
    });
  });

  it("line-dry: now to 18:00 the same day (bounds 18:00 to 21:00, AC-016.4)", () => {
    const now = madrid(22, 9);
    expect(CHORES.laundry_line.ruleWindow(now)).toEqual({ fromMs: now, toMs: madrid(22, 18) });
    expect(CHORES.laundry_line.ruleSettleAt(now)).toBe(madrid(22, 18));
    expect(CHORES.laundry_line.settleBounds(now)).toEqual({
      earliestMs: madrid(22, 18),
      latestMs: madrid(22, 21),
    });
  });

  it("laundry tonight: sunset to 08:00 next day (bounds 08:00 to 10:00)", () => {
    const now = madrid(22, 19);
    const sunset = madrid(22, 20);
    expect(CHORES.laundry_tonight.ruleWindow(now, sunset)).toEqual({
      fromMs: sunset,
      toMs: madrid(23, 8),
    });
    expect(CHORES.laundry_tonight.ruleWindow(madrid(22, 21), sunset).fromMs).toBe(madrid(22, 21));
    expect(CHORES.laundry_tonight.settleBounds(now).latestMs).toBe(madrid(23, 10));
  });

  it("AC: the night that ends next at 07:00 (bounds 07:00 to 09:00), from now if it is under way", () => {
    expect(CHORES.ac.ruleWindow(madrid(22, 15))).toEqual({
      fromMs: madrid(22, 22),
      toMs: madrid(23, 7),
    });
    expect(CHORES.ac.ruleWindow(madrid(23, 3))).toEqual({
      fromMs: madrid(23, 3),
      toMs: madrid(23, 7),
    });
    expect(CHORES.ac.settleBounds(madrid(22, 15))).toEqual({
      earliestMs: madrid(23, 7),
      latestMs: madrid(23, 9),
    });
  });

  it("heater: 08:00 to 22:00 of today, or of tomorrow once 22:00 has passed (bounds 21:00 to 23:00)", () => {
    expect(CHORES.heater.ruleWindow(madrid(22, 5))).toEqual({
      fromMs: madrid(22, 8),
      toMs: madrid(22, 22),
    });
    expect(CHORES.heater.ruleWindow(madrid(22, 14))).toEqual({
      fromMs: madrid(22, 14),
      toMs: madrid(22, 22),
    });
    expect(CHORES.heater.ruleWindow(madrid(22, 23))).toEqual({
      fromMs: madrid(23, 8),
      toMs: madrid(23, 22),
    });
    expect(CHORES.heater.settleBounds(madrid(22, 14))).toEqual({
      earliestMs: madrid(22, 21),
      latestMs: madrid(22, 23),
    });
  });

  it("the rule's settle time is inside the bounds, at any time of day, also across the October change", () => {
    const start = Date.UTC(2026, 9, 23, 22, 0);
    for (let step = 0; step < 48 * 3; step += 1) {
      const now = start + step * 20 * MINUTE;
      for (const type of CHORE_TYPES as readonly ChoreType[]) {
        const chore = CHORES[type];
        const settleAt = chore.ruleSettleAt(now);
        const { earliestMs, latestMs } = chore.settleBounds(now);
        const where = `${type} at ${madridClock(now)}`;
        expect(settleAt, where).toBeGreaterThanOrEqual(earliestMs);
        expect(settleAt, where).toBeLessThanOrEqual(latestMs);
        expect(chore.ruleWindow(now).toMs, where).toBe(settleAt);
        if (chore.offer?.(now).offered !== false) {
          // A chore that is not offered now (line-dry after 15:00) has no window to look at.
          expect(chore.ruleWindow(now).fromMs, where).toBeLessThanOrEqual(settleAt);
        }
      }
    }
  });

  it("clamps what Gemma proposes into the chore's bounds", () => {
    const now = madrid(22, 9);
    expect(clampSettleAt("laundry_line", now, madrid(22, 16))).toBe(madrid(22, 18));
    expect(clampSettleAt("laundry_line", now, madrid(22, 19, 30))).toBe(madrid(22, 19, 30));
    expect(clampSettleAt("laundry_line", now, madrid(22, 23))).toBe(madrid(22, 21));
    expect(clampSettleAt("plants", now, madrid(23, 6))).toBe(madrid(23, 8));
    expect(clampSettleAt("plants", now, madrid(24, 9))).toBe(madrid(23, 12));
    expect(clampSettleAt("heater", now, madrid(22, 21, 30))).toBe(madrid(22, 21, 30));
  });
});

describe("Madrid time helpers", () => {
  it("nextMadridWallTime is the first such wall time strictly after now", () => {
    expect(nextMadridWallTime(madrid(22, 6), 7)).toBe(madrid(22, 7));
    expect(nextMadridWallTime(madrid(22, 7), 7)).toBe(madrid(23, 7));
    expect(nextMadridWallTime(madrid(22, 8), 7)).toBe(madrid(23, 7));
  });

  it("finds 07:00 on the day after the October clock change", () => {
    expect(nextMadridWallTime(Date.UTC(2026, 9, 24, 12), 7)).toBe(Date.UTC(2026, 9, 25, 6, 0)); // CET already
    expect(nextMadridWallTime(Date.UTC(2026, 9, 25, 12), 7)).toBe(Date.UTC(2026, 9, 26, 6, 0));
  });
});

describe("AC-014.3: the age of the forecast in words", () => {
  it.each([
    [0, "Forecast from just now"],
    [59_000, "Forecast from just now"],
    [60_000, "Forecast from 1 min ago"],
    [59 * MINUTE, "Forecast from 59 min ago"],
    [60 * MINUTE, "Forecast from 1 h ago"],
    [3 * 60 * MINUTE + 20 * MINUTE, "Forecast from 3 h ago"],
    [23 * 60 * MINUTE, "Forecast from 23 h ago"],
    [-5_000, "Forecast from just now"],
  ])("%d ms is '%s'", (ageMs, label) => {
    expect(forecastAgeLabel(ageMs)).toBe(label);
  });
});
