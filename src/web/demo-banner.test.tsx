// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { DEMO_BANNER_TEXT } from "./DemoBanner.js";
import { ScoreScreen } from "./ScoreScreen.js";
import { emptyScore, emptyWeek, koala } from "./test-data.js";

const settled = {
  ...emptyScore,
  points: { total: 284 },
  rank: koala,
  calibration: {
    ...emptyScore.calibration,
    settled: 12,
    gemma: emptyScore.calibration.gemma.map((band) => ({ ...band, n: 6, wins: 4, actual_pct: 67 })),
  },
};

describe("AC-029.4: the Sample data banner and the Score watermark", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  function stubServer(demo: boolean): void {
    const today = {
      now: "2026-10-23T08:00:00.000Z",
      demo,
      flags: { score: true, onboarding: true },
      points: { total: 284 },
      week: emptyWeek,
      gemma: { status: "online", detail: "fake model", checked_at: "2026-10-23T08:00:00.000Z" },
      forecast: null,
      attribution: "Weather data by Open-Meteo.com",
      cards: [],
      open_bets: [],
      due_bets: [],
    };
    vi.stubGlobal("fetch", (path: string) => {
      const body =
        path === "/api/today"
          ? today
          : path === "/api/slips"
            ? { now: today.now, settle_now: [], waiting: [], settled: [] }
            : path === "/api/score"
              ? { ...settled, demo }
              : path === "/api/onboarding"
                ? { state: "skipped", household: null }
                : null;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: body === null ? 404 : 200 }),
      );
    });
  }

  async function open(hash: string): Promise<void> {
    window.location.hash = hash;
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  const banner = (): Element | null => container.querySelector('[aria-label="Sample data notice"]');

  it.each(["#/today", "#/slips", "#/score"])(
    "shows the banner on %s in demo mode",
    async (hash) => {
      stubServer(true);
      await open(hash);
      expect(banner()?.textContent).toContain(DEMO_BANNER_TEXT);
      expect(banner()?.getAttribute("role")).toBe("region");
    },
  );

  it("shows no banner when the server is not the demo", async () => {
    stubServer(false);
    await open("#/today");
    expect(banner()).toBeNull();
  });

  it("marks the Score tiles and both charts SAMPLE in demo mode, and only then", () => {
    const flags = { score: true };
    const demo = renderToStaticMarkup(
      <ScoreScreen score={{ ...settled, demo: true }} flags={flags} notice={undefined} />,
    );
    expect(demo.match(/class="sample-watermark"/g)).toHaveLength(3);
    expect(demo).toContain("Sample data · fake model");
    const real = renderToStaticMarkup(
      <ScoreScreen score={settled} flags={flags} notice={undefined} />,
    );
    expect(real).not.toContain("sample-watermark");
    expect(real).not.toContain("fake model");
  });

  it("keeps the watermarked Score free of axe violations", async () => {
    document.body.innerHTML = renderToStaticMarkup(
      <ScoreScreen score={{ ...settled, demo: true }} flags={{ score: true }} notice={undefined} />,
    );
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});
