import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FLAG_NAMES } from "../src/server/flags.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";

let harness: CoreHarness;
let dir: string;

afterEach(async () => {
  await harness.close();
  rmSync(dir, { recursive: true, force: true });
});

async function setup(flags: Parameters<typeof createCoreHarness>[0] = {}): Promise<CoreHarness> {
  dir = mkdtempSync(join(tmpdir(), "sib-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Should I Bother?</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('spa')");
  harness = await createCoreHarness({ webRoot: dir, ...flags });
  await pair(harness);
  return harness;
}

describe("the server serves the built SPA behind the session guard", () => {
  it("serves the page and its assets to a paired device, with the security headers", async () => {
    await setup();
    const page = await harness.get("/");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Should I Bother?");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");

    const script = await harness.get("/assets/app-abc123.js");
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
  });

  it("AC-001.3: gives no page and no asset without a session", async () => {
    await setup();
    for (const url of ["/", "/index.html", "/assets/app-abc123.js"]) {
      const response = await harness.request({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("spa");
      expect(response.body).not.toContain("<title>");
    }
  });

  it("does not serve files outside the built folder, nor unknown paths", async () => {
    await setup();
    for (const url of [
      "/../package.json",
      "/assets/../../package.json",
      "/%2e%2e/package.json",
      "/assets/nope.js",
    ]) {
      const response = await harness.get(url);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain("should-i-bother");
    }
  });

  it("serves the API routes before the static files", async () => {
    await setup();
    expect((await harness.get("/api/today")).headers["content-type"]).toContain("application/json");
  });
});

describe("AC-029.2: the SPA learns which flags are on from /api/today", () => {
  it("reports every flag, off unless switched on", async () => {
    await setup({ flags: { score: true } });
    const { flags } = (await harness.get("/api/today")).json<{ flags: Record<string, boolean> }>();
    expect(Object.keys(flags).sort()).toEqual([...FLAG_NAMES].sort());
    expect(flags["score"]).toBe(true);
    expect(Object.entries(flags).filter(([, on]) => on)).toEqual([["score", true]]);
  });

  it("reports all flags off by default", async () => {
    await setup();
    const { flags } = (await harness.get("/api/today")).json<{ flags: Record<string, boolean> }>();
    expect(Object.values(flags).every((on) => !on)).toBe(true);
  });
});
