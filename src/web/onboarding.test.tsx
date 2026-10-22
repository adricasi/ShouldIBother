// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onboardingSchema, type Onboarding } from "./api.js";
import { App } from "./App.js";
import { Nav } from "./Nav.js";
import { OnboardingScreen, ONBOARDING_PRIVACY_TEXT } from "./OnboardingScreen.js";
import { redirectFor, routeOf } from "./route.js";
import { emptyWeek } from "./test-data.js";

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

  function stubServer(onboardingOn: boolean, state: Onboarding): Call[] {
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
      due_bets: [],
    };
    const slips = { now: today.now, settle_now: [], waiting: [], settled: [] };
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

  it("AC-024.1: the first time the app is opened it asks, and Save sends the answers", async () => {
    const calls = stubServer(true, pending);
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Household");
    // The first checkbox is "Plants on a balcony or terrace".
    click('input[type="checkbox"]');
    click('input[value="vented"]');
    click("button", "Save my answers");
    await settle();
    const save = calls.find((call) => call.line === "PUT /api/onboarding");
    expect(save?.body).toEqual({
      outdoorItems: ["balcony_plants"],
      dryer: "vented",
      airConditioning: false,
      heaterThisSeason: false,
      location: { latitude: 41.4, longitude: 2.16 },
    });
  });

  it("AC-024.2: Skip for now posts the skip and the app carries on with Today", async () => {
    const calls = stubServer(true, pending);
    await render();
    click("button", "Skip for now");
    await settle();
    expect(calls.map((call) => call.line)).toContain("POST /api/onboarding/skip");
    expect(window.location.hash).toBe("#/today");
  });

  it("AC-024.1: an invalid location is refused in words and nothing is sent", async () => {
    const calls = stubServer(true, pending);
    await render();
    const latitude = container.querySelector<HTMLInputElement>("#onboarding-latitude")!;
    act(() => {
      // React ignores a plain `.value =`; the prototype setter makes it see the change.
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") as {
        set: (this: HTMLInputElement, value: string) => void;
      };
      descriptor.set.call(latitude, "95");
      latitude.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click("button", "Save my answers");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Latitude");
    expect(calls.some((call) => call.line.startsWith("PUT"))).toBe(false);
  });

  it("AC-024.2: with the flag off the app never asks and never calls the onboarding routes", async () => {
    const calls = stubServer(false, pending);
    await render();
    expect(container.textContent).not.toContain("Household");
    expect(calls.some((call) => call.line.includes("/api/onboarding"))).toBe(false);
  });
});
