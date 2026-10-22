import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readConfig(name: string): Record<string, unknown> {
  const url = new URL(`../config/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as Record<string, unknown>;
}

describe("committed config files", () => {
  it.each(["flags.json", "rules.json", "household.json", "models.json"])(
    "%s is valid JSON",
    (name) => {
      expect(typeof readConfig(name)).toBe("object");
    },
  );

  it("rules.json maps the five bands to the fixed odds", () => {
    expect(readConfig("rules.json")["bandOdds"]).toEqual([15, 35, 50, 70, 85]);
  });
});
