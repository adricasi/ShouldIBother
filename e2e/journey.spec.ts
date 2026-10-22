import { expect, test, type Page } from "@playwright/test";

type Session = Awaited<ReturnType<ReturnType<Page["context"]>["storageState"]>>;

import { axeViolations } from "./axe.js";
import { TestServer } from "./server.js";

const server = new TestServer();
/** The paired browser session, kept from the journey for the width checks (one token pairs 3 devices). */
let session: Session | undefined;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.dispose();
});

/** Saves a screenshot under test-results/ (git-ignored) so the screens can be compared by eye. */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

async function expectNoViolations(page: Page): Promise<void> {
  expect(await axeViolations(page)).toEqual([]);
}

async function expectNoSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Every button, link and label that acts is at least 44 x 44 px (NFR-009). */
async function expectTouchTargets(page: Page): Promise<void> {
  const small = await page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      "button, a[href], label.button, summary, textarea",
    )) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        continue;
      }
      if (box.width < 44 || box.height < 44) {
        found.push(`${element.textContent?.trim() ?? element.tagName} ${box.width}x${box.height}`);
      }
    }
    return found;
  });
  expect(small).toEqual([]);
}

test("capture, bet, settle at phone width", async ({ page }) => {
  // The page may only talk to the app itself: no font CDN, no analytics (the LAN rule).
  const outside: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(server.origin) && !request.url().startsWith("data:")) {
      outside.push(request.url());
    }
  });

  // Pair this browser, as the phone does with the one-time link.
  await page.goto(server.pairUrl);
  await expect(page.getByRole("heading", { level: 1, name: "The Lazy Bookie" })).toBeVisible();
  session = await page.context().storageState();

  // Today, empty: states, no chores yet.
  await expect(page.getByText("No chores yet")).toBeVisible();
  await expect(
    page.getByText("Gemma runs on your computer at home. Your photos and voice never leave it."),
  ).toBeVisible();
  await shot(page, "01-today-empty");
  await expectNoViolations(page);
  await expectTouchTargets(page);
  await expectNoSideScroll(page);

  // Capture: the quick chip makes a card with odds in plain words.
  await page.getByRole("button", { name: "Water plants" }).click();
  const slip = page.getByRole("article", { name: /^Water plants, / });
  await expect(slip).toBeVisible();
  await expect(slip.getByText(/Lazy Bookie · Bet slip/)).toBeVisible();
  await shot(page, "02-today-slip");
  await expectNoViolations(page);
  await expectTouchTargets(page);
  await expectNoSideScroll(page);

  // Bet: do nothing.
  await slip.getByRole("button", { name: "Bet: do nothing" }).click();
  await expect(page.getByText(/Bet placed/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Undo/ })).toBeVisible();
  await shot(page, "03-today-waiting");
  await expectNoViolations(page);

  // Slips: the bet waits with its countdown.
  await page.getByRole("link", { name: "Slips" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Slips" })).toBeVisible();
  await expect(page.getByText(/left$/)).toBeVisible();
  await shot(page, "04-slips-waiting");
  await expectNoViolations(page);
  await expectTouchTargets(page);

  // The night goes by: restart the server with the bet's settle time in the past.
  await server.stop();
  server.makeBetsDue();
  await server.start();
  await page.goto(`${server.origin}/#/today`);
  await page.reload();

  // Settle by one tap.
  const due = page.getByRole("article", { name: /ready to settle/ });
  await expect(due).toBeVisible({ timeout: 20_000 });
  await expect(due.getByRole("heading", { level: 4, name: "How did it turn out?" })).toBeVisible();
  await shot(page, "05-settle-due");
  await expectNoViolations(page);
  await expectTouchTargets(page);
  await due.getByRole("button", { name: "Still moist, all fine" }).click();

  // The receipt: a win is PAID OUT with its points; a loss is a plain result with its points.
  const receipt = page.getByRole("article", { name: /^Water plants, (You win|Loss)/ });
  await expect(receipt).toBeVisible();
  await expect(receipt.getByText(/^[+−]\d+$/).first()).toBeVisible();
  await shot(page, "06-receipt");
  await expectNoViolations(page);

  // Slips now lists it as settled.
  await page.getByRole("link", { name: "Slips" }).click();
  await expect(page.getByText("Receipt").or(page.getByText("Result")).first()).toBeVisible();
  await shot(page, "07-slips-settled");
  await expectNoViolations(page);
  await expectTouchTargets(page);
  expect(outside).toEqual([]);
});

test("the axe check really sees a violation (so a pass means something)", async ({ page }) => {
  await page.setContent('<html lang="en"><title>t</title><main><img src="x.png"></main></html>');
  expect(await axeViolations(page)).toContainEqual(expect.stringContaining("image-alt"));
});

for (const width of [375, 768, 1280]) {
  test(`Today and Slips fit at ${width} px`, async ({ browser }) => {
    expect(session).toBeDefined();
    const context = await browser.newContext({
      storageState: session as Session,
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(`${server.origin}/#/today`);
    await expect(page.getByRole("heading", { level: 1, name: "The Lazy Bookie" })).toBeVisible();
    await expectNoSideScroll(page);
    await shot(page, `w${width}-today`);
    await expectNoViolations(page);
    await page.getByRole("link", { name: "Slips" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Slips" })).toBeVisible();
    await expectNoSideScroll(page);
    await shot(page, `w${width}-slips`);
    await expectNoViolations(page);
    await context.close();
  });
}
