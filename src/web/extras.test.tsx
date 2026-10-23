import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Card, Today, WeatherBoard as BoardData } from "./api.js";
import { RankHero } from "./RankParts.js";
import { ReceiptCard } from "./SettleParts.js";
import { emptyWeek, koala, lossReceipt, winReceipt } from "./test-data.js";
import { savingsEstimateParts, TodayScreen } from "./TodayScreen.js";
import { Sloth } from "./ui/Sloth.js";
import { WeatherBoard } from "./WeatherBoard.js";

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
  gemma: null,
  quote: {
    id: 1,
    source: "gemma",
    band: 3,
    band_name: "likely",
    odds: 70,
    reason: "Rain is coming.",
    settle_at: "2026-10-23T06:00:00.000Z",
    label: "Gemma's odds",
    provisional: false,
    payouts,
  },
};

const today = (cards: Card[]): Today => ({
  now: "2026-10-22T08:00:00.000Z",
  flags: {},
  points: { total: 0 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
  forecast: null,
  week: emptyWeek,
  attribution: "Weather data by Open-Meteo.com",
  cards,
  open_bets: [],
  due_bets: [],
});

const screen = (value: Today): string =>
  renderToStaticMarkup(
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

describe("AC-011.7: the savings estimate on a bet slip", () => {
  const estimate = {
    time_min: 5,
    water_l: 5,
    electricity_kwh: 0,
    assumption: "5 balcony pots: about 5 L of watering and 5 min skipped",
    basis: "typical estimate",
  };

  it("is worded as an estimate, with its assumption and where it comes from in view", () => {
    const html = screen(today([{ ...card, savings_estimate: estimate }]));
    expect(html).toContain("Saves ~5 min · ~5 L water if the sky does it");
    expect(html).toContain(
      "5 balcony pots: about 5 L of watering and 5 min skipped (typical estimate)",
    );
    // An estimate is not a total: it is nowhere near the week strip's figures.
    expect(html.indexOf("saves-line")).toBeGreaterThan(html.indexOf("slip-top"));
  });

  it("AC-011.4: leaves time out when it is 0, and a part that is 0 out altogether", () => {
    const dryer = {
      water_l: 0,
      electricity_kwh: 2.2,
      assumption: "vs a heat-pump dryer, ~2.2 kWh per load",
      basis: "sourced",
    };
    expect(savingsEstimateParts(dryer)).toEqual(["~2.2 kWh"]);
    const html = screen(today([{ ...card, savings_estimate: dryer }]));
    expect(html).toContain("Saves ~2.2 kWh if the sky does it");
    expect(html).not.toContain("~0");
    expect(html).not.toContain("min if the sky");
    expect(savingsEstimateParts(estimate)).toEqual(["~5 min", "~5 L water"]);
  });

  it("shows nothing when there is no estimate, or when every part is 0", () => {
    expect(screen(today([card]))).not.toContain("saves-line");
    const empty = {
      water_l: 0,
      electricity_kwh: 0,
      assumption: "nothing",
      basis: "typical estimate",
    };
    expect(screen(today([{ ...card, savings_estimate: empty }]))).not.toContain("saves-line");
  });
});

describe("AC-026.3: the place label in the weather board header", () => {
  const board: BoardData = {
    temperature_c: 21,
    condition: "Sunny",
    rain_pct: 10,
    wind_kmh: 18,
    hours: [],
    lazy_window: null,
  };
  const render = (value: BoardData): string =>
    renderToStaticMarkup(
      <WeatherBoard board={value} now="2026-10-22T08:00:00.000Z" forecast={null} />,
    );

  it("heads the board with the label and keeps 'Weather board' for screen readers", () => {
    const html = render({ ...board, place_label: "Gràcia · Barcelona" });
    expect(html).toContain("Gràcia · Barcelona");
    expect(html).toContain('<span class="sr-only">Weather board · </span>');
  });

  it("says 'Weather board' when there is no label", () => {
    const html = render(board);
    expect(html).toContain(">Weather board</h2>");
    expect(html).not.toContain("·");
  });
});

describe("Sloth mascot (design.md Round 3, item 13)", () => {
  it("is decorative: hidden from screen readers, not focusable, no title or text", () => {
    const html = renderToStaticMarkup(<Sloth />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain("<title");
    expect(html).not.toContain("<text");
    expect(html).not.toContain("href=");
  });

  it("hangs over the receipt of a win and not over a loss", () => {
    expect(renderToStaticMarkup(<ReceiptCard receipt={winReceipt} />)).toContain("receipt-sloth");
    expect(renderToStaticMarkup(<ReceiptCard receipt={lossReceipt} />)).not.toContain("sloth");
  });

  it("hangs from the rank card on Score", () => {
    const html = renderToStaticMarkup(<RankHero rank={koala} total={450} />);
    expect(html).toContain("rank-sloth");
    expect(html).toContain('<h2 id="rank-title"');
  });
});
