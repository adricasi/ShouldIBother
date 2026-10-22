import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FLAG_NAMES } from "../src/server/flags.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";

let harness: CoreHarness;
let dir: string;
let outside: string;
const INDEX_HTML = "<!doctype html><title>Should I Bother?</title>";
const OUTSIDE_SECRET = "OUTSIDE-THE-WEB-ROOT-SECRET";

afterEach(async () => {
  await harness.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function setup(flags: Parameters<typeof createCoreHarness>[0] = {}): Promise<CoreHarness> {
  dir = mkdtempSync(join(tmpdir(), "sib-web-"));
  outside = mkdtempSync(join(tmpdir(), "sib-outside-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('spa')");
  writeFileSync(join(dir, ".env"), "DOTFILE-SECRET");
  writeFileSync(join(outside, "secret.txt"), OUTSIDE_SECRET);
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  symlinkSync(outside, join(dir, "linked-dir"));
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
    expect(page.body).toBe(INDEX_HTML);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");

    const script = await harness.get("/assets/app-abc123.js");
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
  });

  it("serves index.html for / and /index.html to a paired session", async () => {
    await setup();
    for (const url of ["/", "/index.html"]) {
      const response = await harness.get(url);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(INDEX_HTML);
    }
  });

  it("AC-001.3: gives no page and no asset without a session", async () => {
    await setup();
    for (const url of ["/", "/index.html", "/assets/app-abc123.js", "/.env", "/link.txt"]) {
      const response = await harness.request({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("spa");
      expect(response.body).not.toContain("<title>");
      expect(response.body).not.toContain(OUTSIDE_SECRET);
      expect(response.body).not.toContain("DOTFILE-SECRET");
      expect(JSON.parse(response.body)).toMatchObject({ status: 401 });
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

  it("does not serve a dotfile, nor a symlink that points outside the web root", async () => {
    await setup();
    for (const url of ["/.env", "/link.txt", "/linked-dir/secret.txt"]) {
      const response = await harness.get(url);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(OUTSIDE_SECRET);
      expect(response.body).not.toContain("DOTFILE-SECRET");
    }
  });

  it("keeps session-gated files out of shared caches: private, and revalidated for the page", async () => {
    await setup();
    for (const url of ["/", "/index.html"]) {
      const response = await harness.get(url);
      expect(response.headers["cache-control"]).toBe("private, no-cache");
    }
    const asset = await harness.get("/assets/app-abc123.js");
    expect(asset.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    for (const response of [await harness.get("/"), asset]) {
      expect(String(response.headers["cache-control"])).not.toContain("public");
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
