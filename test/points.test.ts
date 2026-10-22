import { describe, expect, it } from "vitest";

import {
  DO_IT_POINTS,
  LOSS_POINTS,
  pointsFor,
  roundHalfUp,
  winPoints,
  type DoNothingVerdict,
  type Evidence,
} from "../src/domain/points.js";

const ODDS = [15, 35, 50, 70, 85] as const;

describe("AC-009.1: a do-nothing win pays (100 - odds) x multiplier, rounded half up", () => {
  it.each([
    // odds, after photo (x1.0), one tap (x0.5)
    [15, 85, 43], // 42.5 -> 43
    [35, 65, 33], // 32.5 -> 33
    [50, 50, 25],
    [70, 30, 15],
    [85, 15, 8], // 7.5 -> 8
  ])("odds %i: photo %i, tap %i", (odds, photo, tap) => {
    expect(winPoints(odds, "photo")).toBe(photo);
    expect(winPoints(odds, "tap")).toBe(tap);
  });

  it("auto-settle pays like a tap (x0.5)", () => {
    for (const odds of ODDS) {
      expect(winPoints(odds, "auto")).toBe(winPoints(odds, "tap"));
    }
  });

  it("rounds halves up and everything else to the nearest integer", () => {
    expect(roundHalfUp(7.5)).toBe(8);
    expect(roundHalfUp(7.49)).toBe(7);
    expect(roundHalfUp(7.51)).toBe(8);
    expect(roundHalfUp(0.5)).toBe(1);
  });

  it("is never negative or above 100", () => {
    for (const odds of ODDS) {
      for (const evidence of ["photo", "tap", "auto"] as const) {
        const points = winPoints(odds, evidence);
        expect(points).toBeGreaterThan(0);
        expect(points).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("AC-009.2: losses cost -25, -50 or -150 whatever the evidence", () => {
  const expected: [DoNothingVerdict, number][] = [
    ["small_loss", -25],
    ["normal_loss", -50],
    ["harmful_loss", -150],
  ];

  it.each(expected)("%s is %i", (verdict, points) => {
    expect(LOSS_POINTS[verdict as Exclude<DoNothingVerdict, "win">]).toBe(points);
  });

  it.each(expected)("%s is %i at every odds and for every evidence", (verdict, points) => {
    for (const odds of ODDS) {
      for (const evidence of ["photo", "tap", "auto"] as Evidence[]) {
        expect(pointsFor({ kind: "do_nothing", verdict, odds, evidence })).toBe(points);
      }
    }
  });
});

describe("AC-009.3: a do-it decision scores +5 or -10", () => {
  it("is +5 when the weather would not have done the chore", () => {
    expect(DO_IT_POINTS.weather_would_not).toBe(5);
    expect(
      pointsFor({ kind: "do_it", verdict: "weather_would_not", odds: 70, evidence: "tap" }),
    ).toBe(5);
  });

  it("is -10 when the weather would have done it, at any odds", () => {
    for (const odds of ODDS) {
      expect(
        pointsFor({ kind: "do_it", verdict: "weather_would_have", odds, evidence: "photo" }),
      ).toBe(-10);
    }
  });

  it("refuses verdicts that do not belong to the kind of decision", () => {
    expect(() => pointsFor({ kind: "do_it", verdict: "win", odds: 50, evidence: "tap" })).toThrow(
      "do-it",
    );
    expect(() =>
      pointsFor({ kind: "do_nothing", verdict: "weather_would_not", odds: 50, evidence: "tap" }),
    ).toThrow("do-nothing");
  });
});
