// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { Bet, Card, Slips, Today } from "./api.js";
import { Nav } from "./Nav.js";
import { ROUTE_TITLES, type Route } from "./route.js";
import { ScoreScreen } from "./ScoreScreen.js";
import { SlipsScreen } from "./SlipsScreen.js";
import { answerNeeded, emptyWeek, lossReceipt, winReceipt } from "./test-data.js";
import { TodayScreen, type TodayScreenProps } from "./TodayScreen.js";

const payouts = {
  win_with_photo: 30,
  win_with_tap: 15,
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
  do_it_if_not_needed: 5,
  do_it_if_needed: -10,
};

const NOW = Date.parse("2026-10-22T08:01:00.000Z");

const card: Card = {
  id: 1,
  chore_type: "plants",
  title: "Water plants",
  created_at: "2026-10-22T08:00:00.000Z",
  kind: "weather",
  alert_reason: null,
  notice: null,
  gemma: { state: "question", question: "Is the soil visible?", note: null, can_retry: false },
  photo: {
    id: "0b8d1c52-2d4e-4f0a-9c1d-3b7a5e9f6a10",
    url: "/photos/0b8d1c52-2d4e-4f0a-9c1d-3b7a5e9f6a10",
    state: "seen",
    saw: [{ name: "soil", label: "Soil", value: "damp" }],
    question: null,
    note: null,
    odds_change: {
      before: 35,
      after: 50,
      before_band_name: "unlikely",
      after_band_name: "toss-up",
      text: "35% → 50%",
    },
  },
  quote: {
    id: 1,
    source: "rule",
    band: 3,
    band_name: "likely",
    odds: 70,
    reason: "Rule: 3 mm of rain expected.",
    settle_at: "2026-10-23T06:00:00.000Z",
    label: "Gemma is thinking · rule odds",
    provisional: true,
    payouts,
  },
};

const alertCard: Card = {
  ...card,
  id: 2,
  kind: "alert",
  alert_reason: "Heat: up to 36 °C is forecast.",
  quote: null,
  gemma: null,
  photo: null,
};

const noBetCard: Card = {
  ...card,
  id: 3,
  kind: "coming_later",
  title: "Skip the AC",
  notice: "Not needed this season",
  quote: null,
  gemma: null,
  photo: null,
};

const bet: Bet = {
  id: 7,
  card_id: 1,
  title: "Water plants",
  kind: "do_nothing",
  band: 3,
  band_name: "likely",
  odds: 70,
  odds_source: "rule",
  reason: "Rule: 3 mm of rain expected.",
  placed_at: "2026-10-22T08:00:00.000Z",
  undo_until: "2026-10-22T08:05:00.000Z",
  undoable: true,
  settle_at: "2026-10-23T06:00:00.000Z",
  status: "open",
  payouts,
  tap_answers: [
    { id: "moist", label: "Still moist, all fine" },
    { id: "dry", label: "Soil is dry" },
  ],
  settle: null,
};

const dueBet: Bet = { ...bet, id: 8, status: "due", settle: answerNeeded };

const emptyToday: Today = {
  now: "2026-10-22T08:00:00.000Z",
  flags: { score: true },
  points: { total: 0 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
  forecast: { fetched_at: "2026-10-22T05:00:00.000Z", age_label: "Forecast from 3 h", stale: true },
  week: emptyWeek,
  attribution: "Weather data by Open-Meteo.com",
  cards: [],
  open_bets: [],
  due_bets: [],
};

function today(value: Today | undefined, overrides: Partial<TodayScreenProps> = {}): string {
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
      onPhoto={() => undefined}
      onDeletePhoto={() => undefined}
      onReload={() => undefined}
      {...overrides}
    />,
  );
}

const emptySlips: Slips = {
  now: "2026-10-22T08:01:00.000Z",
  settle_now: [],
  waiting: [],
  settled: [],
};

function slips(
  value: Slips | undefined,
  overrides: { notice?: { kind: "error"; text: string } } = {},
): string {
  return renderToStaticMarkup(
    <SlipsScreen
      slips={value}
      flags={{ score: true }}
      nowMs={NOW}
      busy={false}
      notice={overrides.notice}
      onSettle={() => undefined}
      onSettlePhoto={() => undefined}
      onSettleAnswer={() => undefined}
      onUndo={() => undefined}
      onReload={() => undefined}
    />,
  );
}

describe("NFR-009: core screens have no axe violations (jsdom)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function violationsOf(html: string, route: Route): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = ROUTE_TITLES[route];
    document.body.innerHTML = html;
    // jsdom has no layout, so colour contrast is checked in the Playwright e2e (real Chromium)
    // and on the tokens (styles.test.ts).
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it("Today: loading", async () => {
    expect(await violationsOf(today(undefined), "today")).toEqual([]);
  });

  it("Today: first load failed shows the error state with Try again", async () => {
    const html = today(undefined, {
      notice: { kind: "error", text: "The laptop did not answer." },
    });
    expect(html).toContain("Try again");
    expect(html).not.toContain("Loading");
    expect(await violationsOf(html, "today")).toEqual([]);
  });

  it("Today: empty", async () => {
    expect(await violationsOf(today(emptyToday), "today")).toEqual([]);
  });

  it("Today: every card kind, a waiting bet and a due bet", async () => {
    const html = today({
      ...emptyToday,
      cards: [card, alertCard, noBetCard],
      open_bets: [bet],
      due_bets: [dueBet],
    });
    expect(await violationsOf(html, "today")).toEqual([]);
  });

  it("Today: a win receipt, a loss receipt and an error notice", async () => {
    const html = today(emptyToday, {
      results: { 8: winReceipt, 9: lossReceipt },
      notice: { kind: "error", text: "Gemma could not judge this bet yet" },
    });
    expect(await violationsOf(html, "today")).toEqual([]);
  });

  it("Today: long content wraps (a very long title and note)", async () => {
    const long = "Water the plants on the balcony ".repeat(12);
    const html = today({
      ...emptyToday,
      cards: [
        {
          ...card,
          title: long,
          quote: { ...(card.quote as NonNullable<Card["quote"]>), reason: long },
        },
      ],
    });
    expect(await violationsOf(html, "today")).toEqual([]);
  });

  it("Slips: loading, error, empty", async () => {
    expect(await violationsOf(slips(undefined), "slips")).toEqual([]);
    const failed = slips(undefined, { notice: { kind: "error", text: "No answer." } });
    expect(failed).toContain("Try again");
    expect(await violationsOf(failed, "slips")).toEqual([]);
    expect(await violationsOf(slips(emptySlips), "slips")).toEqual([]);
  });

  it("Slips: settle now, waiting and settled", async () => {
    const html = slips({
      ...emptySlips,
      settle_now: [dueBet],
      waiting: [{ ...bet, time_left_ms: 79_000_000 }],
      settled: [
        {
          ...bet,
          id: 9,
          status: "settled",
          result: {
            verdict: "win",
            points: 15,
            evidence: "tap",
            settled_at: "2026-10-23T06:05:00.000Z",
          },
          receipt: winReceipt,
        },
        {
          ...bet,
          id: 10,
          status: "settled",
          result: {
            verdict: "normal_loss",
            points: -50,
            evidence: "tap",
            settled_at: "2026-10-23T06:05:00.000Z",
          },
          receipt: lossReceipt,
        },
      ],
    });
    expect(await violationsOf(html, "slips")).toEqual([]);
  });

  it("Slips: a waiting bet with the rescue alert and Cash out (REQ-022)", async () => {
    const rescue = {
      can_cash_out: true,
      cash_out_points: -10,
      checked_at: "2026-10-22T08:00:00.000Z",
      alert: {
        text: "The forecast turned against this bet: unlikely (35%) for the rest of the window, down from likely (70%) when you bet.",
        rule_band: 1,
        rule_band_name: "unlikely",
        rule_odds: 35,
        checked_at: "2026-10-22T08:00:00.000Z",
        forecast_at: "2026-10-22T07:50:00.000Z",
      },
    };
    const html = renderToStaticMarkup(
      <SlipsScreen
        slips={{
          ...emptySlips,
          waiting: [
            { ...bet, id: 11, rescue, time_left_ms: 79_000_000 },
            { ...bet, id: 12, rescue: { ...rescue, alert: null }, time_left_ms: 79_000_000 },
          ],
        }}
        flags={{ score: true, rescue: true }}
        nowMs={NOW}
        busy={false}
        notice={undefined}
        onSettle={() => undefined}
        onUndo={() => undefined}
        onCashOut={() => undefined}
        onReload={() => undefined}
      />,
    );
    expect(html).toContain("Rescue alert.");
    expect(html).toContain("Cash out (−10 points)");
    expect(await violationsOf(html, "slips")).toEqual([]);
  });
});

describe("T-018 fix round: states, privacy line and icons", () => {
  const failed = { kind: "error" as const, text: "The laptop did not answer." };

  it("the first-load error state is a live alert on Today, Slips and Score", () => {
    const todayHtml = today(undefined, { notice: failed });
    expect(todayHtml).toMatch(/<section class="error-state" role="alert"/);
    expect(slips(undefined, { notice: failed })).toMatch(
      /<section class="error-state" role="alert"/,
    );
    const scoreHtml = renderToStaticMarkup(
      <ScoreScreen
        score={undefined}
        flags={{ score: true }}
        notice={failed}
        onReload={() => undefined}
      />,
    );
    expect(scoreHtml).toMatch(/<section class="error-state" role="alert"/);
    expect(scoreHtml).toContain("Try again");
  });

  it("names voice in the privacy line only while the voice flag is on, right under the photo button", () => {
    const off = today({ ...emptyToday, cards: [card] });
    expect(off).toContain("Gemma runs on your computer at home. Your photos never leave it.");
    expect(off).not.toContain("and voice");
    const on = today({ ...emptyToday, flags: { voice: true }, cards: [card] });
    expect(on).toContain("Your photos and voice never leave it.");
    // The line follows the photo controls of the card.
    expect(off.indexOf("Delete photo")).toBeLessThan(off.indexOf("never leave it"));
  });

  it("shows the privacy line under the after-photo button on Slips, with the same voice rule", () => {
    const html = slips({ ...emptySlips, settle_now: [dueBet] });
    expect(html.indexOf("Add an after photo for full points")).toBeLessThan(
      html.indexOf("Your photos never leave it."),
    );
    const withVoice = renderToStaticMarkup(
      <SlipsScreen
        slips={{ ...emptySlips, settle_now: [dueBet] }}
        flags={{ voice: true }}
        nowMs={NOW}
        busy={false}
        notice={undefined}
        onSettle={() => undefined}
        onSettlePhoto={() => undefined}
        onUndo={() => undefined}
      />,
    );
    expect(withVoice).toContain("Your photos and voice never leave it.");
  });

  it("the tab bar draws an icon on every tab, also with the score flag off", () => {
    const off = renderToStaticMarkup(<Nav flags={{ score: false }} />);
    expect(off.match(/<svg/g)).toHaveLength(2);
    expect(off).not.toContain("Score");
    const on = renderToStaticMarkup(<Nav flags={{ score: true }} />);
    expect(on.match(/<svg/g)).toHaveLength(3);
    expect(on).toContain("lucide-trophy");
  });

  it("lists the recorded weather on a receipt as a list of chips", () => {
    const html = today(emptyToday, { results: { 8: winReceipt } });
    expect(html).toMatch(/<dd>Modelled recent weather[^<]*<ul class="chips-static"/);
  });
});

describe("NFR-009: the laundry planner card (flag laundryPlanner on) has no axe violations", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const days = [
    { date: "2026-10-22", weekday: "Thursday", band: 1, band_name: "unlikely", odds: 35 },
    { date: "2026-10-23", weekday: "Friday", band: 3, band_name: "likely", odds: 70 },
  ];
  const basePlan: NonNullable<Card["laundry_plan"]> = {
    stage: "wash_today",
    headline: "Wash today",
    reason: "Breezy and dry today, then showers.",
    question: null,
    note: null,
    can_retry: false,
    can_follow: true,
    followed: false,
    advice_points: null,
    advice_reason: null,
    stale: false,
    best_day: { date: "2026-10-23", weekday: "Friday" },
    days,
  };
  const planCard = (plan: Partial<typeof basePlan>): Card => ({
    ...noBetCard,
    id: 9,
    chore_type: "laundry_plan",
    title: "Laundry planner",
    laundry_plan: { ...basePlan, ...plan },
  });
  const planner = (cards: Card[]): string =>
    today(
      { ...emptyToday, flags: { laundryPlanner: true }, cards },
      { onPlanNeed: () => undefined, onPlanFollow: () => undefined },
    );

  async function violationsOf(html: string): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = ROUTE_TITLES.today;
    document.body.innerHTML = html;
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it("shows the Plan the wash chip with an icon", () => {
    expect(planner([])).toContain("Plan the wash");
  });

  it("wash_today", async () => {
    const html = planner([planCard({})]);
    expect(html).toContain("Wash today");
    expect(await violationsOf(html)).toEqual([]);
  });

  it("ask_need and its stale state", async () => {
    const asking = planCard({
      stage: "ask_need",
      headline: "Skip today",
      question: "Need anything washed before Friday?",
    });
    expect(await violationsOf(planner([asking]))).toEqual([]);
    const stale = planCard({
      stage: "ask_need",
      headline: "Skip today",
      question: "Need anything washed before Friday?",
      stale: true,
    });
    const html = planner([stale]);
    expect(html).toContain("out of date");
    expect(await violationsOf(html)).toEqual([]);
  });

  it("thinking, question, offline, followed and no good day", async () => {
    const cards = [
      planCard({ stage: "thinking", headline: null, note: null }),
      planCard({ stage: "question", headline: null, question: "Is it a big load?" }),
      planCard({ stage: "offline", headline: null, note: "Gemma is offline.", can_retry: true }),
      planCard({ followed: true, advice_points: 5 }),
      planCard({ stage: "no_good_day", headline: "No good day", best_day: null }),
    ];
    expect(await violationsOf(planner(cards))).toEqual([]);
  });

  it("a Skip today bet slip with its four days", async () => {
    const slip: Card = {
      ...card,
      id: 10,
      title: "Laundry planner",
      chore_type: "laundry_plan",
      laundry_plan: { ...basePlan, stage: "skip_today", headline: "Skip today" },
      photo: null,
      gemma: null,
    };
    expect(await violationsOf(planner([slip]))).toEqual([]);
  });
});
