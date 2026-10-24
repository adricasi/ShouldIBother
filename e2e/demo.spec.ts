import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations } from "./axe.js";

const ROOT = new URL("../", import.meta.url).pathname;
const START_TIMEOUT_MS = 40_000;
const KILL_AFTER_MS = 5_000;

/** `sib demo` as a laptop user runs it: sample data, fake model, fake weather, a fixed date. */
let child: ChildProcess | undefined;
let pairUrl = "";
let tempDir = "";
let origin = "";
const home = mkdtempSync(join(tmpdir(), "sib-e2e-demo-home-"));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${String(port)}`;
  child = spawn(
    join(ROOT, "node_modules/.bin/tsx"),
    ["src/cli.ts", "demo", "--port", String(port)],
    {
      cwd: ROOT,
      // HOME and the data folder point at throwaway places: the demo must not need the real ones.
      env: { ...process.env, HOME: home, SIB_DATA_DIR: join(home, "live-data") },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const running = child;
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`sib demo did not print its pairing link:\n${output}`));
    }, START_TIMEOUT_MS);
    running.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const link = /http:\/\/127\.0\.0\.1:\d+\/pair\?token=\S+/.exec(output);
      const folder = /Temporary data in (\S+) is deleted/.exec(output);
      if (link !== null && folder?.[1] !== undefined) {
        clearTimeout(timer);
        pairUrl = link[0];
        tempDir = folder[1];
        resolve();
      }
    });
    running.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sib demo exited with ${String(code)}:\n${output}`));
    });
  });
});

test.afterAll(async () => {
  const running = child;
  if (running !== undefined && running.exitCode === null && running.signalCode === null) {
    running.removeAllListeners("exit");
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        running.kill("SIGKILL");
      }, KILL_AFTER_MS);
      running.once("exit", () => {
        clearTimeout(killer);
        resolve();
      });
      running.kill("SIGINT");
    });
  }
  // Stopping the demo deletes its temporary data.
  expect(tempDir === "" || !existsSync(tempDir)).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

async function expectSampleScreen(page: Page, name: string): Promise<void> {
  const banner = page.getByRole("region", { name: "Sample data notice" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Sample data — not real results");
  expect(await axeViolations(page), `${name}: axe`).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name}: side scroll`).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: `test-results/demo/${name}.png`, fullPage: false });
}

test("sample data: Today, Slips, a receipt and Score, each under the banner", async ({ page }) => {
  await page.goto(pairUrl);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Today: the weather board, a card to bet on, the open bets and the one that is ready to settle.
  await page.goto(`${origin}/#/today`);
  await expect(page.getByRole("article", { name: /ready to settle/ })).toHaveCount(1);
  await expect(page.getByText("Sample flat")).toBeVisible();
  await expectSampleScreen(page, "today");
  await shot(page, "01-today");

  // Slips: every group is filled.
  await page.getByRole("link", { name: "Slips" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Slips" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settle now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settled" })).toBeVisible();
  await expect(page.locator(".settled-line").first()).toBeVisible();
  await expectSampleScreen(page, "slips");
  await shot(page, "02-slips");

  // A receipt: the first settled slip opened.
  const first = page.locator(".settled-line").first();
  await first.locator("summary").click();
  await expect(first.locator("article")).toBeVisible();
  await first.scrollIntoViewIfNeeded();
  await expectSampleScreen(page, "receipt");
  await page.screenshot({ path: "test-results/demo/03-receipt.png", fullPage: false });

  // Score: rank, achievements and calibration, with the SAMPLE watermark and label.
  await page.getByRole("link", { name: "Score" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Score" })).toBeVisible();
  await expect(page.getByText("Sample data · fake model")).toBeVisible();
  await expect(page.locator(".sample-watermark")).toHaveCount(3);
  await expectSampleScreen(page, "score");
  await shot(page, "04-score");
});
