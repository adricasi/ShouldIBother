import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Card, CardPhoto, Today } from "./api.js";
import { TodayScreen } from "./TodayScreen.js";

const payouts = {
  win_with_photo: 30,
  win_with_tap: 15,
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
  do_it_if_not_needed: 5,
  do_it_if_needed: -10,
};

const photo: CardPhoto = {
  id: "0b8d1c52-2d4e-4f0a-9c1d-3b7a5e9f6a10",
  url: "/photos/0b8d1c52-2d4e-4f0a-9c1d-3b7a5e9f6a10",
  state: "seen",
  saw: [
    { name: "item", label: "Item", value: "tomato pots" },
    { name: "soil_dryness", label: "Soil", value: "dry" },
  ],
  question: null,
  note: null,
  odds_change: {
    before: 35,
    after: 50,
    before_band_name: "unlikely",
    after_band_name: "toss-up",
    text: "35% → 50%",
  },
};

const card = (override: Partial<Card> = {}): Card => ({
  id: 1,
  chore_type: "plants",
  title: "Water plants",
  created_at: "2026-10-22T08:00:00.000Z",
  kind: "weather",
  alert_reason: null,
  notice: null,
  gemma: { state: "answered", question: null, note: null, can_retry: false },
  quote: {
    id: 2,
    source: "gemma",
    band: 2,
    band_name: "toss-up",
    odds: 50,
    reason: "Showers are possible overnight.",
    settle_at: "2026-10-23T06:00:00.000Z",
    label: "Gemma's odds",
    provisional: false,
    with_photo: true,
    payouts,
  },
  photo,
  ...override,
});

const today = (cards: Card[]): Today => ({
  now: "2026-10-22T08:00:00.000Z",
  flags: {},
  points: { total: 0 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
  forecast: null,
  attribution: "Weather data by Open-Meteo.com",
  cards,
  open_bets: [],
  due_bets: [],
});

function screen(cards: Card[], withActions = true): string {
  return renderToStaticMarkup(
    <TodayScreen
      today={today(cards)}
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
      {...(withActions ? { onPhoto: () => undefined, onDeletePhoto: () => undefined } : {})}
    />,
  );
}

describe("REQ-005: the photo on a bet slip", () => {
  it("offers a photo picker on a card with odds and none on a card without", () => {
    const html = screen([card({ photo: null })]);
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain("Add a photo for sharper odds");
    const alert = screen([card({ kind: "alert", quote: null, alert_reason: "Heat", photo: null })]);
    expect(alert).not.toContain('type="file"');
  });

  it("AC-005.3: shows What Gemma saw and the odds before → after", () => {
    const html = screen([card()]);
    expect(html).toContain("What Gemma saw");
    expect(html).toContain("tomato pots");
    expect(html).toContain("Soil");
    expect(html).toContain("35% → 50%");
    expect(html).toContain('src="/photos/0b8d1c52-2d4e-4f0a-9c1d-3b7a5e9f6a10"');
    expect(html).toContain("Delete photo");
  });

  it("AC-005.4: an unsure photo shows Gemma's question and no odds change", () => {
    const html = screen([
      card({
        photo: {
          ...photo,
          state: "unsure",
          saw: [],
          odds_change: null,
          question: "Is the soil visible in the photo?",
          note: "Gemma couldn't tell from this photo, so the odds stay as they were.",
        },
      }),
    ]);
    expect(html).toContain("Is the soil visible in the photo?");
    expect(html).toContain("odds stay as they were");
    expect(html).not.toContain("What Gemma saw");
    expect(html).not.toContain("→");
  });

  it("says Gemma is looking while the photo is inspected, and does not offer another photo", () => {
    const html = screen([
      card({
        photo: {
          ...photo,
          state: "inspecting",
          saw: [],
          odds_change: null,
          note: "Gemma is looking at your photo.",
        },
      }),
    ]);
    expect(html).toContain("Gemma is looking at your photo.");
    expect(html).not.toContain("Send another photo");
  });

  it("shows no photo controls when the screen cannot upload", () => {
    const html = screen([card()], false);
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("Delete photo");
  });
});
