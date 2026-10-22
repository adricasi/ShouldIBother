import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bet, Card, Settled, Today } from "./api.js";
import { FLAGGED_ENTRIES, visibleEntries, type FlaggedEntry } from "./features.js";
import { formatOdds, formatPoints, formatSettleTime } from "./format.js";
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
};

const emptyToday: Today = {
  now: "2026-10-22T08:00:00.000Z",
  flags: {},
  points: { total: 0 },
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
    expect(html).toContain(formatSettleTime(card.quote.settle_at));
  });

  it("lists waiting bets and the tap answers of a due bet", () => {
    const html = screen({
      ...emptyToday,
      open_bets: [bet],
      due_bets: [{ ...bet, id: 8, status: "due" }],
    });
    expect(html).toContain("Likely · 70% · settles");
    expect(html).toContain("Undo (4 min left)");
    expect(html).toContain("Still moist, all fine");
    expect(html).toContain("Soil is dry");
  });

  it("shows the verdict, reason and points after settling, and error notices as alerts", () => {
    const result: Settled = {
      bet_id: 8,
      verdict: "win",
      reason: "Still moist.",
      evidence: [],
      multiplier: 0.5,
      points: 15,
      total_points: 15,
    };
    const html = screen(emptyToday, {
      results: { 8: result },
      notice: { kind: "error", text: "Gemma could not judge this bet yet" },
    });
    expect(html).toContain("You win · +15");
    expect(html).toContain("Still moist.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Gemma could not judge this bet yet");
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
