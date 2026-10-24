// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RAIN_CHORE_TYPES, type Card, type Today } from "./api.js";
import { OnboardingScreen } from "./OnboardingScreen.js";
import { PhotoBlock } from "./PhotoParts.js";
import { emptyWeek } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";
import { choreIconName } from "./ui/Icon.js";
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

describe("AC-030.1: the rain chips, icons and onboarding items", () => {
  it("shows 'Rinse the car' and 'Terrace' chips only while rainChores is on", () => {
    expect(screen(today({}))).not.toContain("Rinse the car");
    const on = screen(today({ rainChores: true }));
    expect(on).toContain("Rinse the car");
    expect(on).toContain("Terrace");
  });

  it("gives each rain chore its own icon", () => {
    expect(choreIconName("Rinse the car", "car_rinse")).toBe("car");
    expect(choreIconName("Rinse the bike", "bike_rinse")).toBe("bike");
    expect(choreIconName("Rinse the terrace", "terrace_rinse")).toBe("terrace");
    expect(choreIconName("Fill the rain barrel", "rain_fill")).toBe("barrel");
  });

  const household = {
    outdoorItems: [] as ("balcony_plants" | "clothes_line")[],
    dryer: "none" as const,
    airConditioning: false,
    heaterThisSeason: false,
    location: { latitude: 41.4, longitude: 2.16 },
  };
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
      "A rain barrel or bird bath",
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
      expect(block(type), type).toBe("");
    }
  });
});
