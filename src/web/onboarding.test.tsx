// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onboardingSchema, type Bet, type Onboarding } from "./api.js";
import { App } from "./App.js";
import { Nav } from "./Nav.js";
import { OnboardingPrompt, OnboardingScreen, ONBOARDING_PRIVACY_TEXT } from "./OnboardingScreen.js";
import { redirectFor, routeOf } from "./route.js";
import { answerNeeded, emptyWeek } from "./test-data.js";

// Synthetic answers only: no value of a real household.
const pending: Onboarding = {
  state: "pending",
  household: {
    outdoorItems: [],
    dryer: "heat-pump",
    airConditioning: false,
    heaterThisSeason: false,
    location: { latitude: 41.4, longitude: 2.16 },
  },
};
const completed: Onboarding = {
  state: "completed",
  household: {
    outdoorItems: ["balcony_plants", "clothes_line"],
    dryer: "vented",
    airConditioning: true,
    heaterThisSeason: false,
    location: { latitude: 40.42, longitude: -3.7 },
  },
};

function screen(onboarding: Onboarding | undefined, notice?: { kind: "error"; text: string }) {
  return renderToStaticMarkup(
    <OnboardingScreen
      onboarding={onboarding}
      flags={{ onboarding: true }}
      busy={false}
      notice={notice}
      onSave={() => undefined}
      onSkip={() => undefined}
      onReload={() => undefined}
    />,
  );
}

describe("AC-024.1: the household screen asks the five questions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function violationsOf(html: string): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = "Household · Should I Bother?";
    document.body.innerHTML = html;
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it("asks for outdoor items, dryer type, AC and heater use and location, with the privacy line", () => {
    const html = screen(pending);
    for (const text of [
      "What is outside your door?",
      "Plants on a balcony or terrace",
      "A clothes line or drying rack",
      "No dryer",
      "Heat-pump dryer",
      "Vented dryer",
      "I use air conditioning",
      "I heat the home this season",
      "Latitude",
      "Longitude",
      ONBOARDING_PRIVACY_TEXT,
    ]) {
      expect(html).toContain(text);
    }
  });

  it("has no axe violations: first open, answered, loading and failed", async () => {
    expect(await violationsOf(screen(pending))).toEqual([]);
    expect(await violationsOf(screen(completed))).toEqual([]);
    expect(await violationsOf(screen(undefined))).toEqual([]);
    const failed = screen(undefined, { kind: "error", text: "The laptop did not answer." });
    expect(failed).toContain("Try again");
    expect(await violationsOf(failed)).toEqual([]);
  });

  it("offers Skip only until the first answer, and fills the form from the stored answers", () => {
    expect(screen(pending)).toContain("Skip for now");
    const html = screen(completed);
    expect(html).not.toContain("Skip for now");
    expect(html).toContain('value="40.42"');
    expect(html).toContain('value="-3.7"');
  });

  it("shows the Household tab only while the onboarding flag is on (AC-029.2)", () => {
    expect(renderToStaticMarkup(<Nav flags={{ onboarding: false }} />)).not.toContain("Household");
    expect(renderToStaticMarkup(<Nav flags={{ onboarding: true }} />)).toContain("Household");
    expect(routeOf("#/onboarding")).toBe("onboarding");
    expect(redirectFor("onboarding", { onboarding: false })).toBe("#/today");
    expect(redirectFor("onboarding", { onboarding: true })).toBeUndefined();
  });

  it("parses the server's answer", () => {
    expect(onboardingSchema.parse(completed).household.dryer).toBe("vented");
  });
});

const payouts = {
  win_with_photo: 30,
  win_with_tap: 15,
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
  do_it_if_not_needed: 5,
  do_it_if_needed: -10,
};

/** A bet whose settle time has passed: Today shows its tap answers (DueSlip). */
const dueBet: Bet = {
  id: 8,
  card_id: 1,
  title: "Water plants",
  chore_type: "plants",
  kind: "do_nothing",
  band: 3,
  band_name: "likely",
  odds: 70,
  odds_source: "rule",
  reason: "Rule: 3 mm of rain expected.",
  placed_at: "2026-10-21T08:00:00.000Z",
  undo_until: "2026-10-21T08:05:00.000Z",
  undoable: false,
  settle_at: "2026-10-22T06:00:00.000Z",
  status: "due",
  payouts,
  tap_answers: [
    { id: "moist", label: "Still moist, all fine" },
    { id: "dry", label: "Soil is dry" },
  ],
  settle: answerNeeded,
};

describe("REQ-024 in the app", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = "#/today";
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  interface Call {
    readonly line: string;
    readonly body: unknown;
  }

  function stubServer(onboardingOn: boolean, state: Onboarding, emptyApp = false): Call[] {
    const calls: Call[] = [];
    const today = {
      now: "2026-10-22T08:01:00.000Z",
      flags: { onboarding: onboardingOn },
      points: { total: 0 },
      week: emptyWeek,
      gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
      forecast: null,
      attribution: "Weather data by Open-Meteo.com",
      cards: [],
      open_bets: [],
      due_bets: emptyApp ? [] : [dueBet],
    };
    const slips = {
      now: today.now,
      settle_now: emptyApp ? [] : [dueBet],
      waiting: [],
      settled: [],
    };
    vi.stubGlobal("fetch", (path: string, init?: { method?: string; body?: string }) => {
      calls.push({
        line: `${init?.method ?? "GET"} ${path}`,
        body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
      });
      const body =
        path === "/api/today"
          ? today
          : path === "/api/slips"
            ? slips
            : path === "/api/onboarding" && onboardingOn
              ? state
              : path === "/api/onboarding/skip"
                ? { ...state, state: "skipped" }
                : path === "/api/bets/8/settle"
                  ? { state: "awaiting_gemma", note: "Your answer is saved." }
                  : null;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: body === null ? 404 : 200 }),
      );
    });
    return calls;
  }

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const render = async (): Promise<void> => {
    await act(() => {
      root.render(<App />);
      return Promise.resolve();
    });
    await settle();
  };
  const click = (selector: string, text?: string): void => {
    const target = [...container.querySelectorAll<HTMLElement>(selector)].find(
      (element) => text === undefined || element.textContent === text,
    );
    expect(target, `${selector} ${text ?? ""}`).toBeDefined();
    act(() => {
      target!.click();
    });
  };
  const type = (selector: string, value: string): void => {
    const input = container.querySelector<HTMLInputElement>(selector)!;
    act(() => {
      // React ignores a plain `.value =`; the prototype setter makes it see the change.
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") as {
        set: (this: HTMLInputElement, value: string) => void;
      };
      descriptor.set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("AC-024.1: the first time the app is opened Today asks in a card above the chips", async () => {
    const calls = stubServer(true, pending);
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("The Lazy Bookie");
    expect(container.textContent).toContain("Tell me about your home");
    expect(container.querySelector('a[href="#/onboarding"]')?.textContent).toBe(
      "Answer the questions",
    );
    expect(calls.map((call) => call.line)).toContain("GET /api/onboarding");
  });

  it("AC-024.1: an empty app opens on the household questions, laid out like mockup 01", async () => {
    const calls = stubServer(true, pending, true);
    await render();
    expect(container.querySelector(".race-board")).not.toBeNull();
    expect(container.textContent).toContain("Let the sky do your chores.");
    expect(container.textContent).toContain("Step 1 of 1 · 30 seconds");
    expect(container.textContent).toContain("What is outside your door?");
    expect(container.querySelector("button[type=submit]")?.textContent).toBe("Start lazing");
    // The first screen has no tab bar: the way out is Start lazing or Skip for now.
    expect(container.querySelector("nav")).toBeNull();
    expect(container.textContent).not.toContain("Tell me about your home");
    expect(calls.map((call) => call.line)).toContain("GET /api/onboarding");
  });

  it("AC-024.2: Skip for now on the first screen posts the skip and opens Today", async () => {
    const calls = stubServer(true, pending, true);
    await render();
    click("button", "Skip for now");
    await settle();
    expect(calls.map((call) => call.line)).toContain("POST /api/onboarding/skip");
    expect(container.querySelector("nav")).not.toBeNull();
    expect(container.querySelector(".race-board")).toBeNull();
  });

  it("an empty app whose household was answered opens on Today", async () => {
    stubServer(true, completed, true);
    await render();
    expect(container.querySelector(".race-board")).toBeNull();
    expect(container.querySelector("nav")).not.toBeNull();
  });

  it("the place row shows the coordinates, and Change opens the two fields", async () => {
    stubServer(true, pending, true);
    await render();
    const fields =
      container.querySelector<HTMLElement>("#onboarding-latitude")?.parentElement?.parentElement;
    expect(fields?.hidden).toBe(true);
    expect(container.querySelector(".place-text")?.textContent).toBe("41.4, 2.16");
    click("button.place-change");
    expect(fields?.hidden).toBe(false);
    expect(container.querySelector("button.place-change")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("a ticked outdoor tile is a real checkbox inside a labelled tile", async () => {
    stubServer(true, pending, true);
    await render();
    const tile = container.querySelector<HTMLElement>("label.choice.tile");
    expect(tile?.textContent).toContain("Balcony plants");
    expect(tile?.querySelector('input[type="checkbox"]')).not.toBeNull();
    click('label.choice.tile input[type="checkbox"]');
    expect(container.querySelector<HTMLInputElement>("label.choice.tile input")?.checked).toBe(
      true,
    );
  });

  it("a due bet shows on Today and can be settled while onboarding is pending", async () => {
    const calls = stubServer(true, pending);
    await render();
    expect(container.textContent).toContain("Tell me about your home");
    expect(container.textContent).toContain("Water plants");
    click("button", "Still moist, all fine");
    await settle();
    const settleCall = calls.find((call) => call.line === "POST /api/bets/8/settle");
    expect(settleCall?.body).toEqual({ answer: "moist" });
  });

  it("the Today tab works from the household screen, and the Household screen is one tap from the card", async () => {
    stubServer(true, pending);
    await render();
    click('a[href="#/onboarding"]');
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Household");
    click('a[href="#/today"]');
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("The Lazy Bookie");
    expect(container.textContent).toContain("Water plants");
  });

  it("AC-024.1: Save sends the answers and returns to Today", async () => {
    const calls = stubServer(true, pending);
    window.location.hash = "#/onboarding";
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Household");
    // The first checkbox is "Plants on a balcony or terrace".
    click('input[type="checkbox"]');
    click('input[value="vented"]');
    click("button", "Start lazing");
    await settle();
    const save = calls.find((call) => call.line === "PUT /api/onboarding");
    expect(save?.body).toEqual({
      outdoorItems: ["balcony_plants"],
      dryer: "vented",
      airConditioning: false,
      heaterThisSeason: false,
      location: { latitude: 41.4, longitude: 2.16 },
    });
    expect(window.location.hash).toBe("#/today");
  });

  it("AC-024.2: Skip for now on Today posts the skip, hides the card and keeps Today", async () => {
    const calls = stubServer(true, pending);
    await render();
    click("button", "Skip for now");
    await settle();
    expect(calls.map((call) => call.line)).toContain("POST /api/onboarding/skip");
    expect(container.textContent).not.toContain("Tell me about your home");
    expect(container.querySelector("h1")?.textContent).toBe("The Lazy Bookie");
  });

  it.each([
    ["latitude", "95", "41.4", "#onboarding-latitude"],
    ["longitude", "41.4", "0x10", "#onboarding-longitude"],
    ["latitude", "1e1", "2.16", "#onboarding-latitude"],
    ["latitude", "", "2.16", "#onboarding-latitude"],
  ])(
    "AC-024.1: a wrong %s (%s / %s) is refused in words, tied to its field, focused, and nothing is sent",
    async (_name, latitude, longitude, bad) => {
      const calls = stubServer(true, pending);
      window.location.hash = "#/onboarding";
      await render();
      type("#onboarding-latitude", latitude);
      type("#onboarding-longitude", longitude);
      click("button", "Start lazing");
      const field = container.querySelector<HTMLInputElement>(bad)!;
      expect(container.querySelector("#location-error")?.textContent).toContain("Latitude");
      expect(container.querySelector('[role="alert"]')?.id).toBe("location-error");
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toContain("location-error");
      expect(document.activeElement).toBe(field);
      expect(calls.some((call) => call.line.startsWith("PUT"))).toBe(false);
    },
  );

  it("accepts a comma as the decimal mark and negative longitudes", async () => {
    const calls = stubServer(true, pending);
    window.location.hash = "#/onboarding";
    await render();
    type("#onboarding-latitude", "40,42");
    type("#onboarding-longitude", "-3.70");
    click("button", "Start lazing");
    await settle();
    const save = calls.find((call) => call.line === "PUT /api/onboarding");
    expect((save?.body as { location: unknown }).location).toEqual({
      latitude: 40.42,
      longitude: -3.7,
    });
  });

  it("AC-024.2: with the flag off the app never asks and never calls the onboarding routes", async () => {
    const calls = stubServer(false, pending);
    await render();
    expect(container.textContent).not.toContain("Household");
    expect(container.textContent).not.toContain("Tell me about your home");
    expect(calls.some((call) => call.line.includes("/api/onboarding"))).toBe(false);
  });

  it("the card on Today has no axe violations", async () => {
    stubServer(true, pending);
    await render();
    document.documentElement.lang = "en";
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("the prompt renders its two ways out", () => {
    const html = renderToStaticMarkup(<OnboardingPrompt busy={false} onSkip={() => undefined} />);
    expect(html).toContain("Answer the questions");
    expect(html).toContain("Skip for now");
  });
});
