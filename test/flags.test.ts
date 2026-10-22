import { describe, expect, it } from "vitest";

import { buildApp, type FeaturePlugins } from "../src/server/app.js";
import { FLAG_NAMES, loadFlags, parseFlags } from "../src/server/flags.js";

describe("feature flags", () => {
  it("AC-029.1: config/flags.json lists every flag and all of them are off", () => {
    const flags = loadFlags();
    expect(Object.keys(flags).sort()).toEqual([...FLAG_NAMES].sort());
    expect(Object.values(flags).every((on) => !on)).toBe(true);
  });

  it("AC-029.1: a flag missing from the file is off", () => {
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

  it("AC-029.2: with the committed flags, every flagged route is absent", async () => {
    const app = await buildApp({ flags: loadFlags(), features: featurePlugins });
    expect((await app.inject({ method: "GET", url: "/api/score" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });
});
