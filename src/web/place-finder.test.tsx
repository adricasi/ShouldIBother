// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Onboarding, OnboardingAnswers } from "./api.js";
import { OnboardingScreen } from "./OnboardingScreen.js";
import { roundToTwoDecimals } from "./PlaceFinder.js";

// Synthetic answers and places only.
const pending: Onboarding = {
  state: "pending",
  household: {
    outdoorItems: [],
    dryer: "heat-pump",
    airConditioning: false,
    heaterThisSeason: false,
    location: { latitude: 40.42, longitude: -3.7 },
  },
};

const GRACIA = {
  name: "Gràcia",
  admin1: "Barcelona",
  country: "Spain",
  latitude: 41.4,
  longitude: 2.16,
};
const MADRID = {
  name: "Madrid",
  admin1: "Community of Madrid",
  country: "Spain",
  latitude: 40.42,
  longitude: -3.7,
};

type Position = { coords: { latitude: number; longitude: number } };
type PositionHandler = (position: Position) => void;
type ErrorHandler = (error: { code: number }) => void;

let container: HTMLElement;
let root: Root;
let saved: OnboardingAnswers[];
let fetched: string[];

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

type GetCurrentPosition = (
  success: PositionHandler,
  failure: ErrorHandler,
  options: PositionOptions,
) => void;

function setGeolocation(geolocation: { getCurrentPosition: GetCurrentPosition } | undefined): void {
  if (geolocation === undefined) {
    Reflect.deleteProperty(navigator, "geolocation");
  } else {
    Object.defineProperty(navigator, "geolocation", { value: geolocation, configurable: true });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  saved = [];
  fetched = [];
  setSecureContext(true);
  setGeolocation(undefined);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  setSecureContext(false);
  setGeolocation(undefined);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function render(): Promise<void> {
  await act(() => {
    root.render(
      <OnboardingScreen
        onboarding={pending}
        flags={{ onboarding: true }}
        busy={false}
        notice={undefined}
        firstRun
        onSave={(answers) => {
          saved.push(answers);
        }}
        onSkip={() => undefined}
      />,
    );
    return Promise.resolve();
  });
  // The place fields sit behind Change, as they do for a person.
  click("button.place-change");
}

function click(selector: string, text?: string): void {
  const target = [...container.querySelectorAll<HTMLElement>(selector)].find(
    (element) => text === undefined || element.textContent?.trim() === text,
  );
  expect(target, `${selector} ${text ?? ""}`).toBeDefined();
  act(() => {
    target!.click();
  });
}

function type(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") as {
      set: (this: HTMLInputElement, value: string) => void;
    };
    descriptor.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const value = (selector: string): string =>
  container.querySelector<HTMLInputElement>(selector)?.value ?? "";
const status = (): string => container.querySelector('[role="status"]')?.textContent ?? "";
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

/** The laptop's `/api/geocode`, answering with `answer`; records every path asked. */
function stubGeocode(answer: (path: string) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", (path: string) => {
    fetched.push(path);
    return Promise.resolve(answer(path));
  });
}
const found = (...results: unknown[]): Response => new Response(JSON.stringify({ results }));

describe("AC-024.3: Use my location", () => {
  const button = (): HTMLElement | undefined =>
    [...container.querySelectorAll<HTMLElement>("button")].find(
      (element) => element.textContent?.trim() === "Use my location",
    );

  it("is offered in a secure context with the Geolocation API", async () => {
    setGeolocation({ getCurrentPosition: vi.fn<GetCurrentPosition>() });
    await render();
    expect(button()).toBeDefined();
  });

  it("is hidden on plain http, where the browser would refuse, and the search stays", async () => {
    setSecureContext(false);
    setGeolocation({ getCurrentPosition: vi.fn<GetCurrentPosition>() });
    await render();
    expect(button()).toBeUndefined();
    expect(container.querySelector("#onboarding-latitude")).not.toBeNull();
    expect(container.textContent).toContain("Search for a place");
  });

  it("is hidden when the browser has no Geolocation API", async () => {
    await render();
    expect(button()).toBeUndefined();
  });

  it("asks once, coarsely, rounds to 2 decimals in the browser and fills the fields without saving", async () => {
    const getCurrentPosition = vi.fn<GetCurrentPosition>((success) => {
      success({ coords: { latitude: 41.40123456, longitude: 2.15987654 } });
    });
    setGeolocation({ getCurrentPosition });
    stubGeocode(() => found());
    await render();
    click("button", "Use my location");
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    const options = getCurrentPosition.mock.calls[0]![2];
    expect(options.enableHighAccuracy).toBe(false);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maximumAge).toBeGreaterThan(0);
    // The fields hold the rounded numbers, never the raw ones.
    expect(value("#onboarding-latitude")).toBe("41.4");
    expect(value("#onboarding-longitude")).toBe("2.16");
    expect(container.innerHTML).not.toContain("41.4012");
    expect(container.innerHTML).not.toContain("2.1598");
    expect(status()).toContain("Location filled in: 41.4, 2.16");
    // Nothing was sent anywhere and nothing was saved.
    expect(fetched).toEqual([]);
    expect(saved).toEqual([]);
    // Save sends the confirmed, rounded location.
    click("button", "Start lazing");
    expect(saved[0]?.location).toEqual({ latitude: 41.4, longitude: 2.16 });
  });

  it("rounds like the laptop does", () => {
    expect(roundToTwoDecimals(41.40123)).toBe(41.4);
    expect(roundToTwoDecimals(-3.70499)).toBe(-3.7);
    expect(roundToTwoDecimals(2.156)).toBe(2.16);
    expect(roundToTwoDecimals(-0.001)).toBe(-0);
  });

  it.each([
    [1, "Your location was not shared"],
    [2, "could not work out where it is"],
    [3, "took too long"],
  ])("error code %i gets a polite message that points to the search", async (code, words) => {
    setGeolocation({
      getCurrentPosition: (_success, failure) => {
        failure({ code });
      },
    });
    await render();
    click("button", "Use my location");
    expect(status()).toContain(words);
    expect(status().toLowerCase()).toContain("search for your place");
    expect(status()).toContain("type the coordinates");
    // The fields are as they were, and the button works again.
    expect(value("#onboarding-latitude")).toBe("40.42");
    expect(container.querySelector<HTMLButtonElement>("button.button.secondary")?.disabled).toBe(
      false,
    );
    expect(saved).toEqual([]);
  });

  it("a browser that throws is the same as unavailable", async () => {
    setGeolocation({
      getCurrentPosition: () => {
        throw new Error("blocked by policy");
      },
    });
    await render();
    click("button", "Use my location");
    expect(status()).toContain("could not work out where it is");
  });
});

describe("AC-024.4: place search", () => {
  const search = (text: string): void => {
    type("#onboarding-search", text);
    click("button", "Search");
  };

  it("sends nothing while typing; the text goes to the laptop when Search is pressed", async () => {
    stubGeocode(() => found(GRACIA));
    await render();
    type("#onboarding-search", "Gracia");
    await flush();
    expect(fetched).toEqual([]);
    click("button", "Search");
    await flush();
    expect(fetched).toEqual(["/api/geocode?q=Gracia"]);
  });

  it("lists the places as buttons, announces the count, and fills the fields and the label on a choice", async () => {
    stubGeocode(() => found(GRACIA, MADRID));
    await render();
    search("Gracia");
    await flush();
    expect(status()).toBe("2 places found. Choose one.");
    const list = container.querySelector("ul.place-results");
    expect(list?.getAttribute("aria-label")).toBe("Places found");
    const buttons = [...container.querySelectorAll<HTMLElement>("ul.place-results button")];
    expect(buttons.map((element) => element.textContent)).toEqual([
      "Gràcia, BarcelonaSpain · 41.4, 2.16",
      "Madrid, Community of MadridSpain · 40.42, -3.7",
    ]);
    click("ul.place-results button");
    expect(value("#onboarding-latitude")).toBe("41.4");
    expect(value("#onboarding-longitude")).toBe("2.16");
    // The result's name is offered as the label, and stays editable.
    expect(value("#onboarding-place")).toBe("Gràcia, Barcelona");
    expect(document.activeElement?.id).toBe("onboarding-place");
    expect(container.querySelector("ul.place-results")).toBeNull();
    expect(status()).toContain("Gràcia, Barcelona chosen");
    // The text that was typed is dropped once it has done its job.
    expect(value("#onboarding-search")).toBe("");
    type("#onboarding-place", "Home");
    click("button", "Start lazing");
    expect(saved[0]).toMatchObject({
      location: { latitude: 41.4, longitude: 2.16 },
      place_label: "Home",
    });
  });

  it("offers a label that passes the 40 code point rule", async () => {
    const long = { ...GRACIA, name: "N".repeat(30), admin1: "R".repeat(30) };
    stubGeocode(() => found(long));
    await render();
    search("long");
    await flush();
    click("ul.place-results button");
    expect([...value("#onboarding-place")]).toHaveLength(40);
  });

  it("Enter searches and does not save the form", async () => {
    stubGeocode(() => found(GRACIA));
    await render();
    type("#onboarding-search", "Gracia");
    const input = container.querySelector<HTMLInputElement>("#onboarding-search")!;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(fetched).toEqual(["/api/geocode?q=Gracia"]);
    expect(saved).toEqual([]);
  });

  it("asks for 2 to 60 characters before sending anything", async () => {
    stubGeocode(() => found());
    await render();
    search("a");
    await flush();
    expect(fetched).toEqual([]);
    expect(status()).toContain("2 to 60 characters");
    search("   ");
    expect(fetched).toEqual([]);
    search("x".repeat(60));
    await flush();
    expect(fetched).toHaveLength(1);
  });

  it("says so when nothing is found", async () => {
    stubGeocode(() => found());
    await render();
    search("Atlantis");
    await flush();
    expect(status()).toBe("No places found. Try another spelling, or type the coordinates.");
    expect(container.querySelector("ul.place-results")).toBeNull();
  });

  it("says the search is offline on a 503, and too many on a 429", async () => {
    stubGeocode(
      () =>
        new Response(JSON.stringify({ title: "Search is offline; type the coordinates" }), {
          status: 503,
        }),
    );
    await render();
    search("Madrid");
    await flush();
    expect(status()).toBe("Search is offline; type the coordinates.");
    stubGeocode(
      () => new Response(JSON.stringify({ title: "Too many searches" }), { status: 429 }),
    );
    click("button", "Search");
    await flush();
    expect(status()).toContain("a lot of searches in a minute");
    expect(status()).toContain("type the coordinates");
  });

  it("says so when the laptop cannot be reached, and the typed coordinates still work", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network")));
    await render();
    search("Madrid");
    await flush();
    expect(status()).toContain("Can't reach the laptop");
    type("#onboarding-latitude", "41.40");
    click("button", "Start lazing");
    expect(saved[0]?.location.latitude).toBe(41.4);
  });

  it("an older search that answers late does not replace the newer one", async () => {
    const answers: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", (path: string) => {
      fetched.push(path);
      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    await render();
    search("Gracia");
    // The button is busy, so the person edits the text and presses Enter again.
    type("#onboarding-search", "Madrid");
    await act(async () => {
      container
        .querySelector("#onboarding-search")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    expect(fetched).toHaveLength(2);
    await act(async () => {
      answers[1]?.(found(MADRID));
      await Promise.resolve();
    });
    await act(async () => {
      answers[0]?.(found(GRACIA));
      await Promise.resolve();
    });
    await flush();
    expect(
      [...container.querySelectorAll("ul.place-results .place-result-title")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Madrid, Community of Madrid"]);
  });

  it("never calls Open-Meteo from the page, and keeps the text out of the browser's storage", async () => {
    stubGeocode(() => found(GRACIA));
    await render();
    search("Zyxwvut Quarter");
    await flush();
    expect(fetched.every((path) => path.startsWith("/"))).toBe(true);
    expect(fetched.some((path) => path.includes("open-meteo"))).toBe(false);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("Zyxwvut");
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain("Zyxwvut");
    // The input is not a named form field the browser would remember.
    expect(container.querySelector("#onboarding-search")?.hasAttribute("name")).toBe(false);
    expect(container.querySelector("#onboarding-search")?.getAttribute("autocomplete")).toBe("off");
  });

  it("says in the page that the text is sent to Open-Meteo, and only when Search is pressed", async () => {
    await render();
    expect(container.textContent).toContain(
      "What you type is sent to Open-Meteo, only when you press Search.",
    );
  });

  it("has no axe violations with the finder open, with results and with a problem shown", async () => {
    setGeolocation({ getCurrentPosition: vi.fn<GetCurrentPosition>() });
    stubGeocode(() => found(GRACIA, MADRID));
    await render();
    document.documentElement.lang = "en";
    document.title = "Household · Should I Bother?";
    const run = async (): Promise<string[]> =>
      (
        await axe.run(container, { rules: { "color-contrast": { enabled: false } } })
      ).violations.map((violation) => `${violation.id}: ${violation.help}`);
    expect(await run()).toEqual([]);
    search("Gracia");
    await flush();
    expect(await run()).toEqual([]);
    search("a");
    await flush();
    expect(await run()).toEqual([]);
  });
});
