// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { emptyScore, emptyWeek, koala } from "./test-data.js";
import type { Onboarding } from "./api.js";

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

type ScoreAnswer = "rank" | "fail";

describe("App shell: the rank in the points chip, the voice button, focus after first run", () => {
  let container: HTMLElement;
  let root: Root;
  let calls: string[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = "#/today";
    calls = [];
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
    Reflect.deleteProperty(window, "isSecureContext");
  });

  function stubServer(
    flags: Record<string, boolean>,
    options: { score?: ScoreAnswer; emptyApp?: boolean } = {},
  ): void {
    const today = {
      now: "2026-10-22T08:01:00.000Z",
      flags,
      points: { total: 450 },
      week: emptyWeek,
      gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
      forecast: null,
      attribution: "Weather data by Open-Meteo.com",
      cards: [],
      open_bets: [],
      due_bets: [],
    };
    const slips = { now: today.now, settle_now: [], waiting: [], settled: [] };
    vi.stubGlobal("fetch", (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/score" && options.score === "fail") {
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      const body =
        path === "/api/today"
          ? today
          : path === "/api/slips"
            ? slips
            : path === "/api/score"
              ? { ...emptyScore, points: { total: 450 }, rank: koala }
              : path === "/api/onboarding"
                ? pending
                : path === "/api/onboarding/skip"
                  ? { ...pending, state: "skipped" }
                  : null;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: body === null ? 404 : 200 }),
      );
    });
  }

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  const render = async (): Promise<void> => {
    await act(() => {
      root.render(<App />);
      return Promise.resolve();
    });
    await settle();
  };
  const scoreCalls = (): number => calls.filter((call) => call === "GET /api/score").length;

  it("names the rank in the points chip, reading the score once, quietly", async () => {
    stubServer({ score: true, ranks: true });
    await render();
    expect(container.querySelector(".points")?.textContent).toContain("450 points, Koala");
    expect(scoreCalls()).toBe(1);
  });

  it("drops the rank name without a notice when the score cannot be read", async () => {
    stubServer({ score: true, ranks: true }, { score: "fail" });
    await render();
    expect(scoreCalls()).toBe(1);
    expect(container.querySelector(".points")?.textContent).toContain("450 pts");
    expect(container.querySelector(".points")?.textContent).not.toContain("Koala");
    expect(container.querySelector(".notice")).toBeNull();
  });

  it("asks for the score once on the Score screen, not twice", async () => {
    window.location.hash = "#/score";
    stubServer({ score: true, ranks: true });
    await render();
    expect(scoreCalls()).toBe(1);
    expect(container.querySelector("h1")?.textContent).toBe("Score");
  });

  it("never asks for the score for the chip while the ranks flag is off", async () => {
    stubServer({ score: true, ranks: false });
    await render();
    expect(scoreCalls()).toBe(0);
    expect(container.querySelector(".points")?.textContent).toContain("450 pts");
  });

  it("AC-027.3: the raised voice button is in the tab bar only with the voice flag and a microphone", async () => {
    vi.stubGlobal("MediaRecorder", class {});
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: () => undefined },
      configurable: true,
    });
    stubServer({ voice: true });
    await render();
    expect(container.querySelectorAll(".tabbar .tab-fab button.voice-mic")).toHaveLength(1);
    expect(container.querySelector(".tab-fab .voice-mic-label")?.textContent).toBe(
      "Say your chores",
    );
    // The tab bar is then Today, Slips and the button: the same on every screen.
    act(() => {
      window.location.hash = "#/slips";
    });
    await settle();
    expect(container.querySelectorAll(".tabbar .tab-fab button.voice-mic")).toHaveLength(1);
  });

  it("AC-027.3: without a microphone (plain HTTP) the tab bar has no raised button", async () => {
    stubServer({ voice: true });
    await render();
    expect(container.querySelector(".tab-fab")).toBeNull();
    expect(container.querySelectorAll("nav li")).toHaveLength(2);
  });

  it("AC-024.2: leaving the first screen puts the focus on Today's heading and sets the title", async () => {
    stubServer({ onboarding: true });
    await render();
    // An empty app that was never answered opens on the household questions.
    expect(container.querySelector(".race-board")).not.toBeNull();
    const skip = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Skip for now",
    );
    act(() => {
      skip?.click();
    });
    await settle();
    expect(container.querySelector(".race-board")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("h1"));
    expect(document.activeElement?.textContent).toBe("Today");
    expect(document.title).toBe("Today · Should I Bother?");
  });
});
