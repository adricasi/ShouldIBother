import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FeaturePlugins } from "../src/server/app.js";
import { FLAG_NAMES, loadFlags, parseFlags } from "../src/server/flags.js";

import { closeAllHarnesses, createHarness, type Harness } from "./helpers.js";

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
  afterEach(closeAllHarnesses);

  const featurePlugins: FeaturePlugins = {
    score: (app) => {
      app.get("/api/score", () => ({ points: 0 }));
      return Promise.resolve();
    },
  };

  /** A paired app with the given flags; the access control itself is tested in pairing.test.ts. */
  async function pairedApp(
    flags: Record<string, boolean>,
  ): Promise<{ harness: Harness; cookie: string }> {
    const harness = await createHarness({ flags, features: featurePlugins });
    return { harness, cookie: await harness.pairDevice() };
  }

  it("AC-029.2: a flag that is off registers no route", async () => {
    const { harness, cookie } = await pairedApp({ score: false });
    const response = await harness.request({
      method: "GET",
      url: "/api/score",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    await harness.close();
  });

  it("AC-029.2: a flag that is missing from the file registers no route", async () => {
    const { harness, cookie } = await pairedApp({});
    const response = await harness.request({
      method: "GET",
      url: "/api/score",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    await harness.close();
  });

  it("AC-029.2: the same route is served once its flag is on", async () => {
    const { harness, cookie } = await pairedApp({ score: true });
    const response = await harness.request({
      method: "GET",
      url: "/api/score",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ points: 0 });
    await harness.close();
  });

  it("AC-029.2: switching one flag off leaves the unflagged routes untouched", async () => {
    const { harness, cookie } = await pairedApp({ score: false });
    const response = await harness.request({ method: "GET", url: "/healthz", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    await harness.close();
  });
});
