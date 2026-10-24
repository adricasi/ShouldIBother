import { expect, test, type Locator, type Page } from "@playwright/test";

import { axeViolations } from "./axe.js";
import { focusRingProblems } from "./focus.js";
import { TestServer } from "./server.js";

type Session = Awaited<ReturnType<ReturnType<Page["context"]>["storageState"]>>;

// The core journey runs with every flag off, whatever the defaults in config/flags.json are.
const server = new TestServer({ flags: {} });
/** The paired browser session, kept from the journey for the width checks (one token pairs 3 devices). */
let session: Session | undefined;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.dispose();
});

/**
 * Saves a viewport screenshot under test-results/ (git-ignored) so the screens can be compared by
 * eye. The fixed tab bar would cut through a full-page capture, so `focus` is scrolled to the
 * top of the viewport first.
 */
async function shot(page: Page, name: string, focus?: Locator): Promise<void> {
  if (focus === undefined) {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
  } else {
    await focus.evaluate((element) => {
      element.scrollIntoView({ block: "start" });
      window.scrollBy(0, -16);
    });
  }
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: false });
}

async function expectFocusRings(page: Page): Promise<void> {
  expect(await focusRingProblems(page)).toEqual([]);
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
      "button, a[href], label.button, summary, textarea, input:not(.photo-input)",
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
  await expect(page.getByRole("heading", { level: 1, name: "Today", exact: true })).toBeVisible();
  session = await page.context().storageState();

  // Today, empty: states, no chores yet.
  await expect(page.getByText("No chores yet")).toBeVisible();
  await shot(page, "01-today-empty");
  await expectNoViolations(page);
  await expectTouchTargets(page);
  await expectNoSideScroll(page);

  // Capture: the quick chip makes a card with odds in plain words.
  await page.getByRole("button", { name: "Water plants" }).click();
  const slip = page.getByRole("article", { name: /^Water plants, / });
  await expect(slip).toBeVisible();
  await expect(slip.getByText(/Lazy Bookie · Bet slip/)).toBeVisible();
  // The privacy line sits right under the photo button (voice is off, so it names photos only).
  await expect(
    slip.getByText("Gemma runs on your computer at home. Your photos never leave it."),
  ).toBeVisible();
  await expect(page.getByText(/and voice/)).toHaveCount(0);
  await shot(page, "02-today-slip", slip);
  await expectFocusRings(page);
  await expectNoViolations(page);
  await expectTouchTargets(page);
  await expectNoSideScroll(page);

  // Bet: do nothing, once the slip shows Gemma's odds. The rule odds it starts with are replaced
  // by Gemma's a moment later; a bet placed on the old quote is refused ("The odds changed").
  await expect(slip.getByText("Gemma's odds")).toBeVisible();
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
  await expect(due.getByText("How did it turn out?")).toBeVisible();
  await expect(
    due.getByText("Gemma runs on your computer at home. Your photos never leave it."),
  ).toBeVisible();
  await shot(page, "05-settle-due", due);
  await expectFocusRings(page);
  await expectNoViolations(page);
  await expectTouchTargets(page);
  await due.getByRole("button", { name: "Still moist, all fine" }).click();

  // The receipt: a win is PAID OUT with its points; a loss is a plain result with its points.
  const receipt = page.getByRole("article", { name: /^Water plants, (You win|Loss)/ });
  await expect(receipt).toBeVisible();
  await expect(receipt.getByText(/^[+−]\d+$/).first()).toBeVisible();
  await shot(page, "06-receipt", receipt);
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

for (const width of [320, 375, 768, 1280]) {
  test(`Today and Slips fit at ${width} px`, async ({ browser }) => {
    expect(session).toBeDefined();
    const context = await browser.newContext({
      storageState: session as Session,
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(`${server.origin}/#/today`);
    await expect(page.getByRole("heading", { level: 1, name: "Today", exact: true })).toBeVisible();
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
