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
  voice: true,
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
  // The optional place name sits with the coordinates, behind Change (AC-024.1, AC-026.3).
  await page.getByRole("button", { name: "Change" }).click();
  await page.getByLabel("Place name (optional)").fill("Test Quarter · Nowhere");
  await page.getByRole("button", { name: "Start lazing" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Today", exact: true })).toBeAttached();
  await expect(page.getByText("This week the sky did")).toBeVisible();
  await expect(page.getByRole("region", { name: "Weather board" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  // Voice on and a microphone API (localhost is a secure context): one mic per screen (AC-027.3).
  // On a phone it is the raised button of the tab bar, and the capture bar's is not shown.
  await expect(page.getByRole("button", { name: "Say your chores" })).toHaveCount(1);
  await expect(
    page.locator(".tab-fab").getByRole("button", { name: "Say your chores" }),
  ).toBeVisible();
  const raised = await page.locator(".tab-fab > button").boundingBox();
  expect(raised?.width).toBeGreaterThanOrEqual(44);
  await expectScreenIsSound(page, "today");
  expect(await focusRingProblems(page), "today: focus").toEqual([]);

  // A bet on Today shows up on Slips, under the segmented control, with Undo and the countdown.
  // Typed capture: Enter in the field submits the sentence (a real key press, no button).
  await page.getByLabel("Or type your chores in one sentence").fill("water the plants");
  await page.keyboard.press("Enter");
  const slip = page.getByRole("article", { name: /^Water plants, / });
  await expect(slip).toBeVisible();
  // What a win would save, as an estimate (AC-011.7); the place name heads the board (AC-026.3).
  await expect(slip.getByText(/could save ~5 min/i)).toBeVisible();
  await expect(page.locator("#weather-board-title")).toContainText("Test Quarter · Nowhere");
  await expect(slip.getByText("Gemma's odds")).toBeVisible();
  // Gemma is the decision maker, and the fake model says it is not Gemma (AC-028.4).
  await expect(page.getByRole("status").filter({ hasText: "(fake model)" })).toBeVisible();
  await slip.getByText("How Gemma decided").click();
  await expect(slip.getByText("Gemma called get_forecast")).toBeVisible();
  await expect(slip.getByText(/fake model: recorded test answers, not Gemma/)).toBeVisible();
  await expect(slip.getByRole("table", { name: /forecast the tool returned/ })).toBeVisible();
  await expectScreenIsSound(page, "today with the disclosure open");
  await slip.getByRole("button", { name: "Bet: do nothing" }).click();
  await expect(page.getByRole("button", { name: /^Undo/ })).toBeVisible();
  await expectScreenIsSound(page, "today with a bet");

  await page.getByRole("link", { name: "Slips" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Slips" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Jump to a group" })).toBeVisible();
  await page.getByRole("button", { name: /^Waiting/ }).click();
  await expect(page.getByRole("button", { name: /^Waiting/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByRole("button", { name: "Say your chores" })).toHaveCount(1);
  await expectScreenIsSound(page, "slips");
  expect(await focusRingProblems(page), "slips: focus").toEqual([]);

  await page.getByRole("link", { name: "Score" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Score" })).toBeVisible();
  await expectScreenIsSound(page, "score");

  await page.getByRole("link", { name: "Household" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Household" })).toBeAttached();
  await expectScreenIsSound(page, "household");

  // A wide screen: the tab bar is a sidebar and Today has two columns, still sound (mockups D1, D2).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Today", exact: true })).toBeAttached();
  const sidebar = await page.getByRole("navigation", { name: "Main" }).boundingBox();
  expect(sidebar?.x).toBe(0);
  expect(sidebar?.height).toBeGreaterThanOrEqual(900);
  const week = await page.locator(".week").boundingBox();
  const slips = await page.locator("#slips-title").boundingBox();
  expect(week?.x ?? 0).toBeGreaterThan(slips?.x ?? 0);
  // On a wide screen the sidebar has no raised button on Today; the capture bar's mic is the one.
  await expect(page.getByRole("button", { name: "Say your chores" })).toHaveCount(1);
  await expect(
    page.locator(".capture-bar").getByRole("button", { name: "Say your chores" }),
  ).toBeVisible();
  await expectScreenIsSound(page, "today, wide");
  expect(await focusRingProblems(page), "today, wide: focus").toEqual([]);

  // The narrowest phone: five slots in the tab bar, and not one label is cut off.
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.getByRole("button", { name: "Say your chores" })).toHaveCount(1);
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".tabbar a")]
      .filter(
        (link) =>
          link.scrollWidth > link.clientWidth ||
          link.getBoundingClientRect().right > window.innerWidth ||
          link.getBoundingClientRect().left < 0,
      )
      .map((link) => link.textContent?.trim() ?? ""),
  );
  expect(clipped, "tab labels cut off at 320 px").toEqual([]);
  await expectScreenIsSound(page, "today, 320");

  expect(problems).toEqual([]);
});
