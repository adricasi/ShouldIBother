// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RAIN_CHORE_TYPES, type Card, type Today } from "./api.js";
import { OnboardingScreen } from "./OnboardingScreen.js";
import { PhotoBlock } from "./PhotoParts.js";
import { emptyWeek } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";
import { choreIconName, Icon } from "./ui/Icon.js";
import "./zod-config.js";

const today = (flags: Record<string, boolean>): Today => ({
  now: "2026-10-20T07:41:00.000Z",
  flags,
  points: { total: 0 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-20T07:41:00.000Z" },
  forecast: null,
  week: emptyWeek,
  attribution: "Weather data by Open-Meteo.com",
  cards: [],
  open_bets: [],
  due_bets: [],
});

function screen(value: Today): string {
  return renderToStaticMarkup(
    <TodayScreen
      today={value}
      busy={false}
      notice={undefined}
      results={{}}
      nowMs={Date.parse(value.now)}
      onQuickCard={() => undefined}
      onCapture={() => Promise.resolve(true)}
      onRetry={() => undefined}
      onAnswer={() => undefined}
      onBet={() => undefined}
      onDoIt={() => undefined}
      onUndo={() => undefined}
      onSettle={() => undefined}
    />,
  );
}

const household = {
  outdoorItems: [] as ("balcony_plants" | "clothes_line" | "car")[],
  dryer: "none" as const,
  airConditioning: false,
  heaterThisSeason: false,
  location: { latitude: 41.4, longitude: 2.16 },
};

describe("AC-030.1: the rain chips, icons and onboarding items", () => {
  it("shows the rain chips only while rainChores is on", () => {
    expect(screen(today({}))).not.toContain("Rinse the car");
    const on = screen(today({ rainChores: true }));
    expect(on).toContain("Rinse the car");
    expect(on).toContain("Rinse the terrace");
  });

  it("shows the four chips as buttons named by their labels", () => {
    const html = screen(today({ rainChores: true }));
    const document_ = new DOMParser().parseFromString(html, "text/html");
    const names = [...document_.querySelectorAll("button.chip")].map((b) => b.textContent.trim());
    for (const label of [
      "Rinse the car",
      "Rinse the bike",
      "Rinse the terrace",
      "Fill the rain barrel",
    ]) {
      expect(names).toContain(label);
    }
    expect(names).not.toContain("Terrace");
  });

  it("draws the barrel differently from the drop", () => {
    expect(renderToStaticMarkup(<Icon name="barrel" />)).not.toBe(
      renderToStaticMarkup(<Icon name="drop" />),
    );
  });

  it("gives each rain chore its own icon", () => {
    expect(choreIconName("Rinse the car", "car_rinse")).toBe("car");
    expect(choreIconName("Rinse the bike", "bike_rinse")).toBe("bike");
    expect(choreIconName("Rinse the terrace", "terrace_rinse")).toBe("terrace");
    expect(choreIconName("Fill the rain barrel", "rain_fill")).toBe("barrel");
  });

  const onboarding = (flags: Record<string, boolean>): string =>
    renderToStaticMarkup(
      <OnboardingScreen
        onboarding={{ state: "pending", household }}
        flags={flags}
        busy={false}
        notice={undefined}
        onSave={() => undefined}
        onSkip={() => undefined}
      />,
    );

  it("asks about the car, bike, terrace and rain barrel only while rainChores is on", () => {
    expect(onboarding({})).not.toContain("A car on the street");
    const on = onboarding({ rainChores: true });
    for (const text of [
      "A car on the street",
      "A bike kept outside",
      "A terrace or outdoor furniture",
      "A rain barrel, pond or bird bath",
    ]) {
      expect(on).toContain(text);
    }
  });
});

describe("AC-030.2: no before photo on a rain card", () => {
  const card = (choreType: string): Card =>
    ({ id: 1, chore_type: choreType, title: "x", kind: "weather", photo: null }) as unknown as Card;
  const block = (choreType: string): string =>
    renderToStaticMarkup(
      <PhotoBlock
        card={card(choreType)}
        busy={false}
        actions={{ onPhoto: () => undefined, onDeletePhoto: () => undefined }}
      />,
    );

  it("offers the photo on plants and not on any rain bet", () => {
    expect(block("plants")).toContain("Add a photo for sharper odds");
    for (const type of RAIN_CHORE_TYPES) {
      expect(block(type), type).not.toContain("Add a photo");
      expect(block(type), type).toContain("No photo needed now: the rain settles it.");
    }
  });
});

describe("AC-030.2: the slip shows the loss range without the harmful loss", () => {
  const payouts = {
    win_with_photo: 30,
    win_with_tap: 15,
    small_loss: -25,
    normal_loss: -50,
    harmful_loss: -150,
    do_it_if_not_needed: 5,
    do_it_if_needed: -10,
  };
  const rainCard = (noHarmfulLoss: boolean): Card =>
    ({
      id: 3,
      chore_type: noHarmfulLoss ? "car_rinse" : "plants",
      title: noHarmfulLoss ? "Rinse the car" : "Water plants",
      created_at: "2026-10-22T08:00:00.000Z",
      kind: "weather",
      alert_reason: null,
      notice: null,
      no_harmful_loss: noHarmfulLoss,
      gemma: null,
      quote: {
        id: 5,
        source: "rule",
        band: 3,
        band_name: "likely",
        odds: 70,
        reason: "Rule: 5 mm of rain expected.",
        settle_at: "2026-10-23T06:00:00.000Z",
        label: "Rule odds",
        provisional: false,
        with_photo: false,
        payouts,
      },
      photo: null,
    }) as unknown as Card;
  const slip = (card: Card): string =>
    renderToStaticMarkup(
      <TodayScreen
        today={{ ...today({}), cards: [card] }}
        busy={false}
        notice={undefined}
        results={{}}
        nowMs={Date.parse("2026-10-22T08:01:00.000Z")}
        onQuickCard={() => undefined}
        onCapture={() => Promise.resolve(true)}
        onRetry={() => undefined}
        onAnswer={() => undefined}
        onBet={() => undefined}
        onDoIt={() => undefined}
        onUndo={() => undefined}
        onSettle={() => undefined}
      />,
    ).replace(/<!-- -->/g, "");

  it("prints −25 to −50 on a rain bet and −25 to −150 on every other bet", () => {
    expect(slip(rainCard(true))).toContain("If wrong −25 to −50");
    expect(slip(rainCard(true))).not.toContain("−150");
    expect(slip(rainCard(false))).toContain("If wrong −25 to −150");
  });
});

describe("AC-030.1: onboarding keeps a rain item when it is saved with the flag off", () => {
  it("a car ticked while rainChores was on is still sent by a save made with the flag off", async () => {
    const onSave = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <OnboardingScreen
          onboarding={{
            state: "completed",
            household: { ...household, outdoorItems: ["balcony_plants", "car"] },
          }}
          flags={{ onboarding: true }}
          busy={false}
          notice={undefined}
          onSave={onSave}
          onSkip={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("A car on the street");
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ outdoorItems: ["balcony_plants", "car"] });
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });
});
