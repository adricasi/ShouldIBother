import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bet, Card, Today } from "./api.js";
import { FLAGGED_ENTRIES, visibleEntries, type FlaggedEntry } from "./features.js";
import {
  formatDuration,
  formatNetDuration,
  formatOdds,
  formatPoints,
  formatSettleTime,
} from "./format.js";
import { answerNeeded, emptyWeek, lossReceipt, winReceipt } from "./test-data.js";
import { Nav } from "./Nav.js";
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

const card: Card = {
  id: 1,
  chore_type: "plants",
  title: "Water plants",
  created_at: "2026-10-22T08:00:00.000Z",
  kind: "weather",
  alert_reason: null,
  notice: null,
  gemma: { state: "thinking", question: null, note: null, can_retry: false },
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

const bet: Bet = {
  id: 7,
  card_id: 1,
  title: "Water plants",
  chore_type: "plants",
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

const emptyToday: Today = {
  now: "2026-10-22T08:00:00.000Z",
  flags: {},
  points: { total: 0 },
  gemma: { status: "online" as const, detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
  forecast: null,
  week: emptyWeek,
  attribution: "Weather data by Open-Meteo.com",
  cards: [],
  open_bets: [],
  due_bets: [],
};

function screen(today: Today | undefined, overrides: Partial<TodayScreenProps> = {}): string {
  return renderToStaticMarkup(
    <TodayScreen
      today={today}
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
      {...overrides}
    />,
  );
}

describe("AC-029.2: a flag that is off shows no UI entry point", () => {
  const scoreEntry: FlaggedEntry = { flag: "score", id: "score", label: "Score" };

  it("renders only Today while the flag is off, missing or not reported yet", () => {
    for (const flags of [{ score: false }, {}, { somethingElse: true }]) {
      const html = renderToStaticMarkup(<Nav flags={flags} entries={[scoreEntry]} />);
      expect(html).toContain("Today");
      expect(html).not.toContain("Score");
      expect(html).not.toContain("#/score");
    }
  });

  it("renders the entry once the flag is on", () => {
    const html = renderToStaticMarkup(<Nav flags={{ score: true }} entries={[scoreEntry]} />);
    expect(html).toContain('href="#/score"');
    expect(html).toContain("Score");
  });

  it("filters entries by flag", () => {
    const other: FlaggedEntry = { flag: "voice", id: "voice", label: "Voice" };
    expect(visibleEntries([scoreEntry, other], { score: true, voice: false })).toEqual([
      scoreEntry,
    ]);
  });

  it("the whole screen takes its tab bar from the flags in /api/today", () => {
    expect(screen({ ...emptyToday, flags: { score: false } })).not.toContain("Score");
    expect(FLAGGED_ENTRIES.every((entry) => entry.flag.length > 0)).toBe(true);
  });
});

describe("Today screen", () => {
  it("shows the chip, the empty states and the points before any bet", () => {
    const html = screen(emptyToday);
    expect(html).toContain("Water plants");
    expect(html).toContain("No chores yet");
    expect(html).toContain("Open bets wait here");
    expect(html).toContain("Bets ready to settle appear here");
    expect(html).toContain("0 pts");
  });

  it("shows a card with the rule label, plain-word odds, settle time and payouts", () => {
    const html = screen({ ...emptyToday, cards: [card] });
    expect(html).toContain("Gemma is thinking · rule odds");
    expect(html).toContain("70%");
    expect(html).toContain("likely");
    expect(html).toContain("Bet: do nothing");
    expect(html).toContain("Win +15");
    expect(html).toContain(formatSettleTime(card.quote?.settle_at ?? ""));
  });

  it("lists waiting bets and the tap answers of a due bet", () => {
    const html = screen({
      ...emptyToday,
      open_bets: [bet],
      due_bets: [{ ...bet, id: 8, status: "due", settle: answerNeeded }],
    });
    expect(html).toContain("Likely · 70% · settles");
    expect(html).toContain("Undo (4 min left)");
    expect(html).toContain("Still moist, all fine");
    expect(html).toContain("Soil is dry");
  });

  it("the icon of a bet follows its chore type, not a word in its title", () => {
    const iconsOf = (open: Bet): string[] => {
      const line = screen({ ...emptyToday, open_bets: [open] }).split("waiting-line")[1] ?? "";
      return /lucide-[a-z-]+/.exec(line)?.slice(0, 1) ?? [];
    };
    // A title that says nothing, and one that names a different chore than the type.
    expect(iconsOf({ ...bet, title: "Chore", chore_type: "plants" })).toEqual(["lucide-sprout"]);
    expect(iconsOf({ ...bet, title: "Water plants", chore_type: "heater" })).toEqual([
      "lucide-thermometer",
    ]);
    // The planner's Skip today bet is a laundry bet.
    expect(iconsOf({ ...bet, title: "Skip washing today", chore_type: "laundry_plan" })).toEqual([
      "lucide-shirt",
    ]);
    // An unknown type still falls back to the words of the title.
    expect(iconsOf({ ...bet, title: "Water plants", chore_type: "other_weather" })).toEqual([
      "lucide-sprout",
    ]);
  });

  it("AC-010.1: shows the PAID OUT receipt after a win and error notices as alerts", () => {
    const html = screen(emptyToday, {
      results: { 8: winReceipt },
      notice: { kind: "error", text: "Gemma could not judge this bet yet" },
    });
    expect(html).toContain("PAID OUT");
    expect(html).toContain('<span class="result-title">You win</span>');
    expect(html).toContain('<span class="receipt-figure">+15</span>');
    expect(html).toContain("Likely · 70%");
    expect(html).toContain("One tap, paid at half");
    expect(html).toContain("Modelled recent weather (Open-Meteo)");
    expect(html).toContain("Rain 3 mm");
    expect(html).toContain("Time saved");
    expect(html).toContain("5 min");
    expect(html).toContain("Water saved");
    expect(html).toContain("4 L");
    expect(html).toContain("balcony pots");
    expect(html).toContain("Gemma&#x27;s read");
    expect(html).toContain("Still moist.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Gemma could not judge this bet yet");
  });

  it("AC-008.8: a win capped at half because Gemma judged it 24 h late is explained, not blamed on a tap", () => {
    const html = screen(emptyToday, {
      results: {
        8: {
          ...winReceipt,
          evidence: {
            kind: "photo",
            text: "After photo, paid at half: settled 24 hours or more after the settle time",
          },
          multiplier_capped: true,
        },
      },
    });
    expect(html).toContain("settled 24 hours or more after the settle time");
    expect(html).not.toContain("A photo would have paid in full");
  });

  it("AC-010.2: a loss shows the points, the reason and the fixed copy, without the stamp", () => {
    const html = screen(emptyToday, { results: { 9: lossReceipt } });
    expect(html).toContain('<span class="result-title">Loss</span>');
    expect(html).toContain('<span class="receipt-figure">−50</span>');
    expect(html).toContain("The soil is dry.");
    expect(html).toContain("The weather did not cover this one");
    expect(html).not.toContain("PAID OUT");
    expect(html).not.toContain("Water saved");
  });

  it("renders without data while loading", () => {
    expect(screen(undefined)).toContain("Loading");
  });

  it("formats points with a real minus sign", () => {
    expect(formatPoints(15)).toBe("+15");
    expect(formatPoints(-150)).toBe("−150");
    expect(formatPoints(0)).toBe("0");
  });

  it("AC-003.5: odds carry plain words", () => {
    expect(formatOdds("toss-up", 50)).toBe("Toss-up · 50%");
    expect(formatOdds("very unlikely", 15)).toBe("Very unlikely · 15%");
  });

  it("formats times in Madrid time", () => {
    expect(formatSettleTime("2026-10-23T06:00:00.000Z")).toBe("Fri 23 Oct, 08:00");
  });
});

describe("T-005: chips, alerts, notices, forecast age and attribution on Today", () => {
  const alertCard: Card = {
    ...card,
    id: 2,
    kind: "alert",
    alert_reason: "Heat: up to 36 °C is forecast.",
    quote: null,
  };
  const noticeCard: Card = {
    ...card,
    id: 3,
    kind: "coming_later",
    title: "Skip the AC",
    notice: "Not needed this season",
    quote: null,
  };

  it("offers a quick chip for each Must chore: water the plants and line-dry today", () => {
    const html = screen(emptyToday);
    expect(html).toContain("Water plants");
    expect(html).toContain("Line-dry today");
  });

  it("AC-012.1: an alert shows Do it now with its reason and no bet action", () => {
    const html = screen({ ...emptyToday, cards: [alertCard] });
    expect(html).toContain("Do it now");
    expect(html).toContain("Heat: up to 36 °C is forecast.");
    expect(html).not.toContain("Bet: do nothing");
    expect(html).not.toContain("I&#x27;ll do it");
  });

  it("AC-014.4, AC-016.5: a card without odds shows its notice and no bet action", () => {
    const html = screen({ ...emptyToday, cards: [noticeCard] });
    expect(html).toContain("Skip the AC");
    expect(html).toContain("Not needed this season");
    expect(html).not.toContain("Bet: do nothing");
    expect(html).not.toContain("%");
  });

  it("AC-014.3: shows how old the forecast is, and says so when a fresh one failed", () => {
    const fresh = screen({
      ...emptyToday,
      forecast: {
        fetched_at: "2026-10-22T05:00:00.000Z",
        age_label: "Forecast from 3 h ago",
        stale: true,
      },
    });
    expect(fresh).toContain("Forecast from 3 h ago");
    expect(fresh).toContain("could not be reached");
    const ok = screen({
      ...emptyToday,
      forecast: {
        fetched_at: "2026-10-22T07:50:00.000Z",
        age_label: "Forecast from 10 min ago",
        stale: false,
      },
    });
    expect(ok).toContain("Forecast from 10 min ago");
    expect(ok).not.toContain("could not be reached");
    expect(screen(emptyToday)).not.toContain("Forecast from");
  });

  it("AC-014.6: shows the Open-Meteo attribution", () => {
    expect(screen(emptyToday)).toContain("Weather data by Open-Meteo.com");
  });
});

describe("T-006: Gemma on Today (REQ-002, REQ-003, REQ-013)", () => {
  const gemmaCard = (
    gemma: NonNullable<Card["gemma"]>,
    source: "rule" | "gemma" = "rule",
  ): Card => ({
    ...card,
    gemma,
    quote: card.quote === null ? null : { ...card.quote, source },
  });

  it("AC-003.5: the odds tile and the slip name carry plain words with the percentage", () => {
    const html = screen({ ...emptyToday, cards: [card] });
    expect(html).toContain('aria-label="Likely · 70%"');
    expect(html).toContain("Water plants, Likely · 70%");
  });

  it("AC-002.1: offers a labelled text box limited to 500 characters and a submit button", () => {
    const html = screen(emptyToday);
    expect(html).toContain('<input id="capture-text" type="text"');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain("Or type your chores in one sentence");
    expect(html).toMatch(/<button type="submit"[^>]*aria-label="Get odds"/);
  });

  it("AC-013.5: shows Gemma's status, with the fake model said out loud", () => {
    const status = (gemma: Today["gemma"]): string => screen({ ...emptyToday, gemma });
    const at = "2026-10-22T08:00:00.000Z";
    expect(status({ status: "online", detail: null, checked_at: at })).toContain("Gemma is online");
    expect(status({ status: "waking", detail: null, checked_at: at })).toContain("waking up");
    expect(status({ status: "offline", detail: null, checked_at: at })).toContain(
      "Gemma is offline, rule odds only",
    );
    expect(status({ status: "online", detail: "fake model", checked_at: at })).toContain(
      "(fake model)",
    );
  });

  it("AC-013.3: an offline card keeps its bet buttons and offers Retry with the reason", () => {
    const html = screen({
      ...emptyToday,
      cards: [
        gemmaCard({
          state: "offline",
          question: null,
          note: "Gemma is not running.",
          can_retry: true,
        }),
      ],
    });
    expect(html).toContain("Gemma is not running.");
    expect(html).toContain("Retry Gemma");
    expect(html).toContain("Bet: do nothing");
  });

  it("AC-003.3: a question is shown inside the card as two tap answers", () => {
    const html = screen({
      ...emptyToday,
      cards: [
        gemmaCard({
          state: "question",
          question: "Are the pots under a roof?",
          note: null,
          can_retry: false,
        }),
      ],
    });
    expect(html).toContain("Are the pots under a roof?");
    expect(html).toMatch(/>Yes<\/button>/);
    expect(html).toMatch(/>No<\/button>/);
    expect(html).not.toContain("Retry Gemma");
  });

  it("a thinking or answered card shows no Retry", () => {
    for (const state of ["thinking", "answered"] as const) {
      const html = screen({
        ...emptyToday,
        cards: [gemmaCard({ state, question: null, note: null, can_retry: false }, "gemma")],
      });
      expect(html).not.toContain("Retry Gemma");
    }
  });

  it("AC-002.2, AC-002.3: a card without odds says why and has no bet action", () => {
    for (const notice of ["Not a weather chore", "Coming later"]) {
      const html = screen({
        ...emptyToday,
        cards: [
          {
            ...card,
            kind: notice === "Coming later" ? "coming_later" : "not_weather",
            title: "pay the bill",
            notice,
            quote: null,
            gemma: null,
          },
        ],
      });
      expect(html).toContain(notice);
      expect(html).toContain("pay the bill");
      expect(html).not.toContain("Bet: do nothing");
    }
  });
});

describe("This week's savings on Today (AC-011.3, AC-011.5, AC-011.6)", () => {
  it("shows net time back with both parts, water and electricity, each with its assumption", () => {
    const html = screen({
      ...emptyToday,
      week: {
        from: "2026-10-19",
        to: "2026-10-25",
        totals: {
          bets: 12,
          wins: 2,
          time_saved_s: 7800,
          app_time_s: 360,
          net_time_s: 7440,
          water_l: 38,
          electricity_kwh: 6.5,
          assumptions: [
            {
              chore_type: "laundry_line",
              assumption: "vs a heat-pump dryer, ~2.2 kWh per load; no minutes saved",
              basis: "sourced",
              wins: 2,
            },
          ],
        },
      },
    });
    expect(html).toContain("This week the sky did");
    expect(html).toContain("+2 h 4 min");
    expect(html).toContain("2 h 10 min saved, minus 6 min spent on 12 bets.");
    expect(html).toContain("38 L");
    expect(html).toContain("6.5 kWh");
    expect(html).toContain("vs a heat-pump dryer");
    expect(html).toContain("(sourced)");
  });

  it("formats durations and a negative net time with a real minus sign", () => {
    expect(formatDuration(30)).toBe("30 s");
    expect(formatDuration(90)).toBe("1 min 30 s");
    expect(formatDuration(3600 * 2 + 600)).toBe("2 h 10 min");
    expect(formatDuration(0)).toBe("0 min");
    expect(formatNetDuration(-120)).toBe("−2 min");
    expect(formatNetDuration(300)).toBe("+5 min");
    expect(formatNetDuration(0)).toBe("0 min");
  });
});
