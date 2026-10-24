// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";

import {
  fetchToday,
  setDeploymentMode,
  type Bet,
  type Card,
  type Slips,
  type Today,
} from "./api.js";
import { OnboardingScreen, ONBOARDING_PRIVACY_TEXT } from "./OnboardingScreen.js";
import { SlipsScreen } from "./SlipsScreen.js";
import { answerNeeded, emptyWeek } from "./test-data.js";
import { gemmaStatusText, TodayHeader } from "./TodayParts.js";
import { TodayScreen, type TodayScreenProps } from "./TodayScreen.js";
import { hostedPrivacyText, privacyText } from "./ui/PrivacyNote.js";

/*
 * AC-032.4, AC-032.6: the screens say where Gemma runs, and show no photo block while the server
 * takes no photos. The home copy stays word for word.
 */

const NOW = Date.parse("2026-10-22T08:01:00.000Z");
const MODEL = "gemma-4-31B-it";

const PRIVACY_PHOTOS_OFF =
  "Gemma runs on DigitalOcean's inference service. Your chores, habits, answers and area forecast are sent there. Photos are off.";
const PRIVACY_PHOTOS_ON =
  "Gemma runs on DigitalOcean's inference service. Your chores, habits, answers, area forecast and the photos you add are sent there.";
const HOME_PRIVACY = "Gemma runs on your computer at home. Your photos never leave it.";

const payouts = {
  win_with_photo: 30,
  win_with_tap: 15,
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
  do_it_if_not_needed: 5,
  do_it_if_needed: -10,
};

const card: Card = {
  id: 1,
  chore_type: "plants",
  title: "Water plants",
  created_at: "2026-10-22T08:00:00.000Z",
  kind: "weather",
  alert_reason: null,
  notice: null,
  gemma: { state: "answered", question: null, note: null, can_retry: false },
  photo: null,
  quote: {
    id: 1,
    source: "gemma",
    band: 3,
    band_name: "likely",
    odds: 70,
    reason: "Rain is due.",
    settle_at: "2026-10-23T06:00:00.000Z",
    label: "Gemma's odds",
    provisional: false,
    payouts,
  },
};

const dueBet: Bet = {
  id: 8,
  card_id: 1,
  title: "Water plants",
  chore_type: "plants",
  kind: "do_nothing",
  band: 3,
  band_name: "likely",
  odds: 70,
  odds_source: "gemma",
  reason: "Rain is due.",
  placed_at: "2026-10-22T08:00:00.000Z",
  undo_until: "2026-10-22T08:05:00.000Z",
  undoable: false,
  settle_at: "2026-10-23T06:00:00.000Z",
  status: "due",
  payouts,
  tap_answers: [
    { id: "moist", label: "Still moist, all fine" },
    { id: "dry", label: "Soil is dry" },
  ],
  settle: answerNeeded,
};

function todayOf(extra: Partial<Today> = {}): Today {
  return {
    now: "2026-10-22T08:00:00.000Z",
    flags: { score: true },
    points: { total: 0 },
    gemma: { status: "online", detail: MODEL, checked_at: "2026-10-22T08:00:00.000Z" },
    forecast: null,
    week: emptyWeek,
    attribution: "Weather data by Open-Meteo.com",
    cards: [card],
    open_bets: [],
    due_bets: [dueBet],
    ...extra,
  };
}

const HOSTED_PHOTOS_OFF = todayOf({ mode: "hosted", photos: false });
const HOSTED_PHOTOS_ON = todayOf({ mode: "hosted", photos: true });

function renderToday(value: Today, overrides: Partial<TodayScreenProps> = {}): string {
  const photosOn = value.photos !== false;
  return renderToStaticMarkup(
    <TodayScreen
      today={value}
      busy={false}
      notice={undefined}
      results={{}}
      nowMs={NOW}
      onQuickCard={() => undefined}
      onCapture={() => Promise.resolve(true)}
      onRetry={() => undefined}
      onAnswer={() => undefined}
      onBet={() => undefined}
      onDoIt={() => undefined}
      onUndo={() => undefined}
      onSettle={() => undefined}
      onReload={() => undefined}
      {...(photosOn
        ? {
            onPhoto: () => undefined,
            onDeletePhoto: () => undefined,
            onSettlePhoto: () => undefined,
          }
        : {})}
      {...overrides}
    />,
  );
}

const slipsOf = (value: Today): Slips => ({
  now: "2026-10-22T08:01:00.000Z",
  settle_now: value.due_bets,
  waiting: [],
  settled: [],
});

function renderSlips(value: Today): string {
  const photosOn = value.photos !== false;
  return renderToStaticMarkup(
    <SlipsScreen
      slips={slipsOf(value)}
      flags={value.flags}
      mode={value.mode}
      photos={value.photos}
      nowMs={NOW}
      busy={false}
      notice={undefined}
      onSettle={() => undefined}
      {...(photosOn ? { onSettlePhoto: () => undefined } : {})}
      onSettleAnswer={() => undefined}
      onUndo={() => undefined}
      onReload={() => undefined}
    />,
  );
}

describe("AC-032.6: the status line says where Gemma runs", () => {
  it("reads Gemma 4 · DigitalOcean · <model ID> in hosted mode", () => {
    const gemma = todayOf().gemma;
    expect(gemmaStatusText(gemma, "hosted")).toBe(`Gemma 4 · DigitalOcean · ${MODEL}`);
    const html = renderToStaticMarkup(
      <TodayHeader today={HOSTED_PHOTOS_OFF} rankName={undefined} />,
    );
    expect(html).toContain(`Gemma 4 · DigitalOcean · ${MODEL}`);
    expect(html).not.toContain("on this laptop");
  });

  it("keeps the home line word for word, and the offline words in both modes", () => {
    const home = { ...todayOf().gemma, detail: "gemma4:e4b" };
    expect(gemmaStatusText(home)).toBe("Gemma 4 E4B · on this laptop");
    expect(gemmaStatusText(home, "home")).toBe("Gemma 4 E4B · on this laptop");
    const offline = { ...home, status: "offline" as const };
    expect(gemmaStatusText(offline, "hosted")).toBe("Gemma is offline, rule odds only");
    expect(gemmaStatusText(offline)).toBe("Gemma is offline, rule odds only");
  });
});

describe("AC-032.6: the privacy line", () => {
  it("uses the exact sentences, with photos off and with SIB_DO_VISION=1", () => {
    expect(hostedPrivacyText(false)).toBe(PRIVACY_PHOTOS_OFF);
    expect(hostedPrivacyText(true)).toBe(PRIVACY_PHOTOS_ON);
    expect(privacyText(false, { photos: false })).toBe(PRIVACY_PHOTOS_OFF);
    expect(privacyText(false, { photos: true })).toBe(PRIVACY_PHOTOS_ON);
  });

  it("is on Today in hosted mode even with no photo button, and not in home mode", () => {
    expect(renderToday(HOSTED_PHOTOS_OFF)).toContain(PRIVACY_PHOTOS_OFF.replace("'", "&#x27;"));
    expect(renderToday(HOSTED_PHOTOS_ON)).toContain(PRIVACY_PHOTOS_ON.replace("'", "&#x27;"));
    expect(renderToday(todayOf())).not.toContain("DigitalOcean");
  });

  it("keeps 'Your photos never leave it' for home mode only", () => {
    expect(privacyText(false)).toBe(HOME_PRIVACY);
    expect(privacyText(true)).toBe(
      "Gemma runs on your computer at home. Your photos and voice never leave it.",
    );
    expect(renderToday(todayOf())).toContain(HOME_PRIVACY);
    expect(renderToday(HOSTED_PHOTOS_ON)).not.toContain("never leave it");
    expect(renderToday(HOSTED_PHOTOS_OFF)).not.toContain("never leave it");
    expect(renderSlips(HOSTED_PHOTOS_ON)).not.toContain("never leave it");
    expect(renderSlips(HOSTED_PHOTOS_ON)).toContain("photos you add are sent there");
  });

  it("the household screen says the answers are on this server, not on the computer", () => {
    const props = {
      onboarding: {
        state: "completed" as const,
        household: {
          airConditioning: false,
          heaterThisSeason: false,
          dryer: "heat-pump" as const,
          location: { latitude: 41.4, longitude: 2.16 },
          outdoorItems: [],
        },
      },
      flags: { onboarding: true },
      busy: false,
      notice: undefined,
      onSave: () => undefined,
      onSkip: () => undefined,
    };
    const hosted = renderToStaticMarkup(<OnboardingScreen {...props} hosted />);
    const home = renderToStaticMarkup(<OnboardingScreen {...props} />);
    expect(hosted).toContain("stored on this server");
    expect(hosted).not.toContain("on your computer");
    expect(home).toContain(ONBOARDING_PRIVACY_TEXT);
  });
});

describe("AC-032.4: no photo block while the server takes no photos", () => {
  it("hides the photo buttons on Today and the after photo in Slips, and says one tap settles", () => {
    for (const html of [renderToday(HOSTED_PHOTOS_OFF), renderSlips(HOSTED_PHOTOS_OFF)]) {
      expect(html).not.toContain('type="file"');
      expect(html).not.toContain("Add a photo");
      expect(html).not.toContain("after photo");
      expect(html).toContain("One tap settles it and pays a win at half points");
      expect(html).not.toContain("A photo pays a win in full");
    }
  });

  it("shows them with SIB_DO_VISION=1 and in home mode", () => {
    for (const html of [
      renderToday(HOSTED_PHOTOS_ON),
      renderToday(todayOf()),
      renderSlips(HOSTED_PHOTOS_ON),
      renderSlips(todayOf()),
    ]) {
      expect(html).toContain('type="file"');
      expect(html).toContain("A photo pays a win in full");
    }
    expect(renderToday(todayOf())).toContain("Add a photo for sharper odds");
  });
});

describe("AC-032.6, NFR-009: the hosted screens have no axe violations (jsdom)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function violationsOf(html: string): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = "Should I Bother?";
    document.body.innerHTML = html;
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it("Today and Slips, photos off and on", async () => {
    for (const html of [
      renderToday(HOSTED_PHOTOS_OFF),
      renderToday(HOSTED_PHOTOS_ON),
      renderSlips(HOSTED_PHOTOS_OFF),
      renderSlips(HOSTED_PHOTOS_ON),
    ]) {
      expect(await violationsOf(html)).toEqual([]);
    }
  });
});

describe("AC-032.4, AC-032.6: the app reads the mode from /api/today", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function openApp(value: Today, hash: string): Promise<HTMLElement> {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.location.hash = hash;
    vi.stubGlobal("fetch", (path: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            path === "/api/today" ? value : path === "/api/slips" ? slipsOf(value) : null,
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return container;
  }

  it("shows no photo block and the hosted status line with photos off", async () => {
    const today = await openApp(HOSTED_PHOTOS_OFF, "#/today");
    expect(today.querySelector('input[type="file"]')).toBeNull();
    expect(today.textContent).toContain(`Gemma 4 · DigitalOcean · ${MODEL}`);
    expect(today.textContent).toContain(PRIVACY_PHOTOS_OFF);
    const slips = await openApp(HOSTED_PHOTOS_OFF, "#/slips");
    expect(slips.querySelector('input[type="file"]')).toBeNull();
    expect(slips.textContent).toContain("One tap settles it");
  });

  it("keeps the photo block in home mode, as before", async () => {
    const today = await openApp(todayOf(), "#/today");
    expect(today.querySelector('input[type="file"]')).not.toBeNull();
    expect(today.textContent).toContain("on this laptop");
  });
});

describe("AC-032.6: errors name the server, not the laptop, in hosted mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setDeploymentMode(undefined);
  });

  const failing = (): void => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
  };
  const answering = (status: number, body: unknown): void => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/problem+json" },
        }),
      ),
    );
  };

  it("home keeps the laptop words, word for word", async () => {
    failing();
    await expect(fetchToday()).rejects.toThrow(
      "Can't reach the laptop. Check the Wi-Fi and try again.",
    );
    answering(401, {
      title: "Unauthorized",
      detail: "Open the pairing link printed on the laptop, or run `sib pair` there.",
    });
    await expect(fetchToday()).rejects.toThrow(
      "This device is not paired. Open the pairing link shown on the laptop.",
    );
    answering(500, {});
    await expect(fetchToday()).rejects.toThrow("The laptop answered 500.");
  });

  it("a hosted 401 shows the server's hint, even before any answer has named the mode", async () => {
    answering(401, {
      title: "Unauthorized",
      detail: "Run `sib pair` on the server and open the link it prints.",
    });
    await expect(fetchToday()).rejects.toThrow(
      "This device is not paired. Run `sib pair` on the server and open the link it prints.",
    );
    // From then on the app knows it is hosted.
    failing();
    await expect(fetchToday()).rejects.toThrow("Can't reach the server. Check your connection.");
  });

  it("the mode of /api/today sets the words for the other errors", async () => {
    answering(200, HOSTED_PHOTOS_OFF);
    await fetchToday();
    failing();
    await expect(fetchToday()).rejects.toThrow("Can't reach the server. Check your connection.");
    answering(502, {});
    await expect(fetchToday()).rejects.toThrow("The server answered 502.");
    answering(401, {});
    await expect(fetchToday()).rejects.toThrow(
      "This device is not paired. Run `sib pair` on the server and open the link it prints.",
    );
    // Back to home when the answer says home.
    answering(200, todayOf());
    await fetchToday();
    failing();
    await expect(fetchToday()).rejects.toThrow("Can't reach the laptop.");
  });
});
