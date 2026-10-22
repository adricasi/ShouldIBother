import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_DIR, DEFAULT_PORT, loadHousehold, readJsonFile } from "../src/server/config.js";

function readConfig(name: string): Record<string, unknown> {
  return readJsonFile(`${CONFIG_DIR}${name}`) as Record<string, unknown>;
}

describe("committed config files", () => {
  it.each(["flags.json", "rules.json", "household.example.json", "models.json"])(
    "%s is valid JSON",
    (name) => {
      expect(typeof readConfig(name)).toBe("object");
    },
  );

  it("rules.json maps the five bands to the fixed odds", () => {
    expect(readConfig("rules.json")["bandOdds"]).toEqual([15, 35, 50, 70, 85]);
  });

  // The rule thresholds are final for this version (design.md, no tuning). Any edit to them
  // must be deliberate: update this hash in the same change. Top-level "_comment" keys are
  // excluded, and T-005's schema must allow or strip them.
  it("rules.json thresholds are pinned to the design values", () => {
    const thresholds = { ...readConfig("rules.json") };
    delete thresholds["_comment"];
    const hash = createHash("sha256").update(JSON.stringify(thresholds)).digest("hex");
    expect(hash).toBe("0dbe42ccfb1d5428defe50d56cfb2b0cf8375af3ac0fc001c069ae02d1960665");
  });

  it("the default port is 8787 (design A-13)", () => {
    expect(DEFAULT_PORT).toBe(8787);
  });
});

describe("loadHousehold", () => {
  const example = {
    airConditioning: false,
    heaterThisSeason: false,
    dryer: "heat-pump",
  };

  it("falls back to the committed example when household.json is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "sib-household-"));
    writeFileSync(join(dir, "household.example.json"), JSON.stringify(example));
    try {
      expect(loadHousehold(`${dir}/`)).toEqual(example);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("prefers household.json over the example", () => {
    const dir = mkdtempSync(join(tmpdir(), "sib-household-"));
    writeFileSync(join(dir, "household.example.json"), JSON.stringify(example));
    writeFileSync(
      join(dir, "household.json"),
      JSON.stringify({ ...example, airConditioning: true }),
    );
    try {
      expect(loadHousehold(`${dir}/`).airConditioning).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects an invalid household file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sib-household-"));
    writeFileSync(join(dir, "household.json"), JSON.stringify({ dryer: 3 }));
    try {
      expect(() => loadHousehold(`${dir}/`)).toThrow("Invalid household config");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("household location (AC-014.1)", () => {
  function householdIn(content: unknown): ReturnType<typeof loadHousehold> {
    const dir = mkdtempSync(join(tmpdir(), "sib-household-"));
    writeFileSync(join(dir, "household.example.json"), JSON.stringify(content));
    try {
      return loadHousehold(`${dir}/`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
  const base = { airConditioning: false, heaterThisSeason: false, dryer: "heat-pump" };

  it("reads the coordinates when given, and none when the file has none", () => {
    expect(
      householdIn({ ...base, location: { latitude: 41.4, longitude: 2.16 } }).location,
    ).toEqual({
      latitude: 41.4,
      longitude: 2.16,
    });
    expect(householdIn(base).location).toBeUndefined();
  });

  it("the committed example carries neighbourhood-level coordinates", () => {
    expect(readConfig("household.example.json")["location"]).toEqual({
      latitude: 41.4,
      longitude: 2.16,
    });
  });

  it("refuses coordinates outside the globe or with extra keys", () => {
    expect(() => householdIn({ ...base, location: { latitude: 95, longitude: 2 } })).toThrow();
    expect(() =>
      householdIn({ ...base, location: { latitude: 41, longitude: 2, street: "x" } }),
    ).toThrow();
  });
});
