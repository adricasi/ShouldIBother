import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp, type FeaturePlugins } from "../src/server/app.js";
import { FLAG_NAMES, loadFlags, parseFlags } from "../src/server/flags.js";

describe("feature flags", () => {
  it("AC-029.1: config/flags.json lists every flag", () => {
    expect(Object.keys(loadFlags()).sort()).toEqual([...FLAG_NAMES].sort());
  });

  it("AC-029.1: every flag is off by default", () => {
    expect(parseFlags({ score: true }).score).toBe(true);
    expect(parseFlags({ score: true }).voice).toBe(false);
    expect(Object.values(parseFlags({})).every((on) => !on)).toBe(true);
  });

  it.each([
    ["an unknown flag name", { notAFlag: true }],
    ["a non-boolean value", { score: "yes" }],
    ["a non-object", []],
  ])("AC-029.1: rejects %s", (_label, raw) => {
    expect(() => parseFlags(raw)).toThrow("Invalid feature flags");
  });
});

describe("loadFlags", () => {
  it("names the file when it is missing", () => {
    expect(() => loadFlags("/nonexistent/flags.json")).toThrow("/nonexistent/flags.json");
  });

  it("names the file when the JSON is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "sib-flags-"));
    const path = join(dir, "flags.json");
    writeFileSync(path, "{ not json");
    try {
      expect(() => loadFlags(path)).toThrow(`Invalid JSON in config file ${path}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("flagged routes", () => {
  const featurePlugins: FeaturePlugins = {
    score: (app) => {
      app.get("/api/score", () => ({ points: 0 }));
      return Promise.resolve();
    },
  };

  it("AC-029.2: a flag that is off registers no route", async () => {
    const app = await buildApp({ flags: parseFlags({ score: false }), features: featurePlugins });
    const response = await app.inject({ method: "GET", url: "/api/score" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("AC-029.2: a flag that is missing from the file registers no route", async () => {
    const app = await buildApp({ flags: parseFlags({}), features: featurePlugins });
    const response = await app.inject({ method: "GET", url: "/api/score" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("AC-029.2: the same route is served once its flag is on", async () => {
    const app = await buildApp({ flags: parseFlags({ score: true }), features: featurePlugins });
    const response = await app.inject({ method: "GET", url: "/api/score" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ points: 0 });
    await app.close();
  });

  it("AC-029.2: switching one flag off leaves the unflagged routes untouched", async () => {
    const app = await buildApp({ flags: parseFlags({ score: false }), features: featurePlugins });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });
});
