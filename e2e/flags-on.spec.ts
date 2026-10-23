import { expect, test, type Page } from "@playwright/test";

import { axeViolations } from "./axe.js";
import { focusRingProblems } from "./focus.js";
import { TestServer } from "./server.js";

/** Every flag the screens depend on, on: the all-flags look of the app (the default is all off). */
const ALL_ON = {
  score: true,
  stampAnimation: true,
  laundryPlanner: true,
  rescue: true,
  appeals: true,
  onboarding: true,
  ranks: true,
  heater: true,
  splitFlap: true,
} as const;

const server = new TestServer();
const problems: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // The first start makes the server's copy of the config; the flags are set while it is stopped.
  await server.start();
  await server.stop();
  server.setFlags(ALL_ON);
  await server.start();
});

test.afterAll(async () => {
  await server.dispose();
});

async function expectScreenIsSound(page: Page, name: string): Promise<void> {
  expect(await axeViolations(page), `${name}: axe`).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name}: side scroll`).toBeLessThanOrEqual(0);
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "button, a[href], label.button, summary, input:not(.photo-input)",
      ),
    ]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44))
      .map(
        ({ element, box }) =>
          `${element.textContent?.trim() ?? element.tagName} ${box.width}x${box.height}`,
      ),
  );
  expect(small, `${name}: targets under 44 px`).toEqual([]);
}

test("all flags on: first open, onboarding, Today and Score are sound and quiet", async ({
  page,
}) => {
  // The browser console must stay empty: a Content-Security-Policy violation shows up here.
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    problems.push(String(error));
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSP ${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  await page.goto(server.latestPairUrl);

  // First open of an empty app: the household questions, like mockup 01 (AC-024.1).
  await expect(page.getByRole("button", { name: "Start lazing" })).toBeVisible();
  await expect(page.getByText("Let the sky do your chores.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expectScreenIsSound(page, "first open");
  expect(await focusRingProblems(page), "first open: focus").toEqual([]);

  await page.getByRole("checkbox", { name: /Balcony plants/ }).check();
  await page.getByRole("button", { name: "Start lazing" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "The Lazy Bookie" })).toBeAttached();
  await expect(page.getByText("This week the sky did")).toBeVisible();
  await expect(page.getByRole("region", { name: "Weather board" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expectScreenIsSound(page, "today");
  expect(await focusRingProblems(page), "today: focus").toEqual([]);

  // A bet on Today shows up on Slips, under the segmented control, with Undo and the countdown.
  await page.getByRole("button", { name: "Water plants" }).click();
  const slip = page.getByRole("article", { name: /^Water plants, / });
  await expect(slip).toBeVisible();
  await slip.getByRole("button", { name: "Bet: do nothing" }).click();
  await expect(page.getByRole("button", { name: /^Undo/ })).toBeVisible();
  await expectScreenIsSound(page, "today with a bet");

  await page.getByRole("link", { name: "Slips" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Slips" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Show a group of slips" })).toBeVisible();
  await page.getByRole("button", { name: /^Waiting/ }).click();
  await expect(page.getByRole("button", { name: /^Waiting/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectScreenIsSound(page, "slips");
  expect(await focusRingProblems(page), "slips: focus").toEqual([]);

  await page.getByRole("link", { name: "Score" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Score" })).toBeVisible();
  await expectScreenIsSound(page, "score");

  await page.getByRole("link", { name: "Household" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Household" })).toBeAttached();
  await expectScreenIsSound(page, "household");

  expect(problems).toEqual([]);
});
