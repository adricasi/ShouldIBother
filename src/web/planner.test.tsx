// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { cardSchema, type Card, type Plan, type Today } from "./api.js";
import { emptyWeek } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";

const days = [
  { date: "2026-10-22", weekday: "Thursday", band: 1, band_name: "unlikely", odds: 35 },
  { date: "2026-10-23", weekday: "Friday", band: 2, band_name: "toss-up", odds: 50 },
  { date: "2026-10-24", weekday: "Saturday", band: 3, band_name: "likely", odds: 70 },
  { date: "2026-10-25", weekday: "Sunday", band: 2, band_name: "toss-up", odds: 50 },
];

const basePlan: Plan = {
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
  best_day: { date: "2026-10-22", weekday: "Thursday" },
  days,
};

const payouts = {
  win_with_photo: 30,
  win_with_tap: 15,
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
  do_it_if_not_needed: 5,
  do_it_if_needed: -10,
};

function planCard(plan: Partial<Plan>, overrides: Partial<Card> = {}): Card {
  return {
    id: 7,
    chore_type: "laundry_plan",
    title: "Laundry planner",
    created_at: "2026-10-22T07:00:00.000Z",
    kind: "coming_later",
    alert_reason: null,
    notice: "Wash today. Breezy and dry today, then showers.",
    quote: null,
    gemma: null,
    laundry_plan: { ...basePlan, ...plan },
    ...overrides,
  };
}

function today(cards: Card[], flags: Record<string, boolean> = { laundryPlanner: true }): Today {
  return {
    now: "2026-10-22T07:00:00.000Z",
    flags,
    points: { total: 0 },
    gemma: { status: "online", detail: null, checked_at: "2026-10-22T07:00:00.000Z" },
    forecast: null,
    week: emptyWeek,
    attribution: "Weather data by Open-Meteo.com",
    cards,
    open_bets: [],
    due_bets: [],
  };
}

function screen(data: Today, busy = false): string {
  return renderToStaticMarkup(
    <TodayScreen
      today={data}
      busy={busy}
      notice={undefined}
      results={{}}
      nowMs={Date.parse("2026-10-22T07:01:00.000Z")}
      onQuickCard={() => undefined}
      onCapture={() => Promise.resolve(true)}
      onRetry={() => undefined}
      onAnswer={() => undefined}
      onBet={() => undefined}
      onDoIt={() => undefined}
      onUndo={() => undefined}
      onSettle={() => undefined}
      onPlanNeed={() => undefined}
      onPlanFollow={() => undefined}
    />,
  );
}

describe("AC-021.1: the planner card shows Wash today, Skip today or No good day with the four days", () => {
  it("AC-021.1: Wash today lists the four days with their drying odds and says it is not a bet", () => {
    const html = screen(today([planCard({})]));
    expect(html).toContain("Wash today");
    for (const day of days) {
      expect(html).toContain(day.weekday);
    }
    expect(html).toContain("Likely · 70%");
    expect(html).toContain("This is advice, not a bet.");
    expect(html).not.toContain("Bet: do nothing");
  });

  it("AC-021.1: No good day offers neither a bet nor advice to follow", () => {
    const html = screen(
      today([
        planCard({
          stage: "no_good_day",
          headline: "No good day",
          can_follow: false,
          best_day: null,
        }),
      ]),
    );
    expect(html).toContain("No good day");
    expect(html).not.toContain("I am washing today");
    expect(html).not.toContain("Bet: do nothing");
  });

  it("AC-021.1: a planner that is thinking, or offline with Retry, says so", () => {
    expect(screen(today([planCard({ stage: "thinking", headline: null, days: [] })]))).toContain(
      "Gemma is planning your wash.",
    );
    const offline = screen(
      today([
        planCard({
          stage: "offline",
          headline: null,
          days: [],
          note: "Gemma is not running.",
          can_retry: true,
        }),
      ]),
    );
    expect(offline).toContain("Gemma is not running.");
    expect(offline).toContain("Retry Gemma");
  });

  it("AC-021.1: the Plan the wash chip is there only while the flag is on", () => {
    expect(screen(today([], { laundryPlanner: true }))).toContain("Plan the wash");
    expect(screen(today([], { laundryPlanner: false }))).not.toContain("Plan the wash");
    expect(screen(today([], {}))).not.toContain("Plan the wash");
  });

  it("AC-021.1: a card from the server parses, and an ordinary card has no plan", () => {
    const parsed = cardSchema.parse(JSON.parse(JSON.stringify(planCard({}))));
    expect(parsed.laundry_plan?.stage).toBe("wash_today");
    const plain = { ...planCard({}), laundry_plan: undefined };
    expect(cardSchema.parse(JSON.parse(JSON.stringify(plain))).laundry_plan).toBeUndefined();
  });
});

describe("AC-021.2: Skip today first asks 'Need anything washed before <day>?'", () => {
  const asking = planCard({
    stage: "ask_need",
    headline: "Skip today",
    can_follow: false,
    question: "Need anything washed before Saturday?",
    best_day: { date: "2026-10-24", weekday: "Saturday" },
  });

  it("AC-021.2: the Yes and No taps are a group named by the question", () => {
    const html = screen(today([asking]));
    expect(html).toContain('role="group" aria-labelledby="plan-question-7"');
    expect(html).toContain('id="plan-question-7"');
    expect(html).toContain("One question first");
    expect(html).not.toContain("No bet");
  });

  it("AC-014.2: a plan more than an hour old asks for a new plan instead of Yes and No", () => {
    const html = screen(
      today([{ ...asking, laundry_plan: { ...asking.laundry_plan!, stale: true } }]),
    );
    expect(html).toContain("This plan is out of date");
    expect(html).not.toContain(">Yes<");
  });

  it("explains a disabled tap while the app is busy", () => {
    const html = screen(today([planCard({})]), true);
    expect(html).toContain("Working on your last tap");
    expect(html).toContain('aria-describedby="plan-hint-7"');
  });

  it("AC-021.2: shows Skip today with the question as two tap answers and no bet action", () => {
    const html = screen(today([asking]));
    expect(html).toContain("Skip today");
    expect(html).toContain("Need anything washed before Saturday?");
    expect(html).toContain(">Yes<");
    expect(html).toContain(">No<");
    expect(html).not.toContain("Bet: do nothing");
  });
});

describe("AC-021.3 and AC-021.5: following Wash today, and the Skip today bet slip", () => {
  it("AC-021.3: a followed Wash today shows its points; one that earned none says why", () => {
    const earned = screen(
      today([planCard({ followed: true, can_follow: false, advice_points: 5 })]),
    );
    expect(earned).toContain("+5 points for advice followed.");
    const followedWith = (advice_reason: Plan["advice_reason"]) =>
      screen(
        today([planCard({ followed: true, can_follow: false, advice_points: 0, advice_reason })]),
      );
    expect(followedWith("not_best_day")).toContain("No points: today is not the best drying day.");
    expect(followedWith("too_late")).toContain("only before 18:00");
    const capped = followedWith("daily_cap");
    expect(capped).toContain("once a day");
    expect(capped).not.toContain("not the best drying day");
    expect(screen(today([planCard({})]))).toContain("I am washing today");
  });

  it("AC-021.5: a Skip today card with odds is a bet slip at the planner's band, with no I'll do it", () => {
    const slip = planCard(
      {
        stage: "skip_today",
        headline: "Skip today",
        can_follow: false,
        best_day: { date: "2026-10-24", weekday: "Saturday" },
      },
      {
        kind: "weather",
        notice: null,
        gemma: { state: "answered", question: null, note: null, can_retry: false },
        quote: {
          id: 4,
          source: "gemma",
          band: 3,
          band_name: "likely",
          odds: 70,
          reason: "Light wind and sun on Saturday.",
          settle_at: "2026-10-24T16:00:00.000Z",
          label: "Gemma's odds",
          provisional: false,
          payouts,
        },
      },
    );
    const html = screen(today([slip]));
    expect(html).toContain("Likely · 70%");
    expect(html).toContain("Bet: do nothing");
    expect(html).toContain("Skip today wins if the load dries outside on Saturday.");
    expect(html).not.toContain("I&#x27;ll do it");
    expect(html).not.toContain("photo");
  });
});

describe("NFR-009: planner cards have no accessibility violations (axe)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("every stage of the planner card passes axe", async () => {
    const cards = [
      planCard({}),
      planCard({
        stage: "no_good_day",
        headline: "No good day",
        can_follow: false,
        best_day: null,
      }),
      planCard({
        stage: "ask_need",
        headline: "Skip today",
        can_follow: false,
        question: "Need anything washed before Saturday?",
      }),
      planCard({ stage: "thinking", headline: null, days: [] }),
      planCard({ stage: "offline", headline: null, days: [], can_retry: true, note: "Offline." }),
    ].map((card, index) => ({ ...card, id: index + 1 }));
    document.documentElement.lang = "en";
    document.title = "Today";
    document.body.innerHTML = screen(today(cards));
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});
