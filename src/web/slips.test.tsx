import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bet, Slips } from "./api.js";
import { undoMinutesLeft } from "./BetParts.js";
import { formatTimeLeft } from "./format.js";
import { answerNeeded, emptyWeek, lossReceipt, winReceipt } from "./test-data.js";
import { Nav } from "./Nav.js";
import {
  POLL_INTERVAL_MS,
  estimateServerNow,
  startPolling,
  type VisibilitySource,
} from "./polling.js";
import { SLIPS_EMPTY_TEXT, SlipsScreen } from "./SlipsScreen.js";
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

const NOW = Date.parse("2026-10-22T08:01:00.000Z");

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

const emptySlips: Slips = {
  now: "2026-10-22T08:01:00.000Z",
  settle_now: [],
  waiting: [],
  settled: [],
};

function slipsHtml(slips: Slips | undefined): string {
  return renderToStaticMarkup(
    <SlipsScreen
      slips={slips}
      flags={{}}
      nowMs={NOW}
      busy={false}
      notice={undefined}
      onSettle={() => undefined}
      onUndo={() => undefined}
    />,
  );
}

describe("Slips screen (REQ-007)", () => {
  it("AC-007.3: every empty group says what will appear there", () => {
    const html = slipsHtml(emptySlips);
    for (const text of Object.values(SLIPS_EMPTY_TEXT)) {
      expect(html).toContain(text.replace("'", "&#x27;"));
    }
    expect(html).toContain("Settle now");
    expect(html).toContain("Waiting");
    expect(html).toContain("Settled");
  });

  it("AC-007.1: shows the countdown in Waiting, a tap per answer in Settle now, result and points in Settled", () => {
    const html = slipsHtml({
      ...emptySlips,
      settle_now: [{ ...bet, id: 1, status: "due", settle: answerNeeded }],
      waiting: [{ ...bet, id: 2, time_left_ms: 22 * 3_600_000 }],
      settled: [
        {
          ...bet,
          id: 3,
          status: "settled",
          result: {
            verdict: "win",
            points: 15,
            evidence: "tap",
            settled_at: "2026-10-22T09:00:00.000Z",
          },
          receipt: winReceipt,
        },
      ],
    });
    expect(html).not.toContain("appear here");
    expect(html).toContain("Still moist, all fine");
    // Settle time 2026-10-23 06:00Z minus now 08:01Z the day before: 21 h 59 min left.
    expect(html).toContain("21 h 59 min left");
    expect(html).toContain("Undo (4 min left)");
    expect(html).toContain("You win");
    expect(html).toContain("+15");
  });

  it("shows do-it decisions without a tap question, and the Gemma-offline step in words", () => {
    const html = slipsHtml({
      ...emptySlips,
      settle_now: [
        {
          ...bet,
          id: 4,
          kind: "do_it",
          status: "due",
          settle: {
            ...answerNeeded,
            state: "waiting_gemma",
            note: "Gemma checks the recorded weather to score it.",
          },
        },
        {
          ...bet,
          id: 5,
          status: "awaiting_gemma",
          settle: {
            ...answerNeeded,
            state: "waiting_gemma",
            answered_with: "tap",
            note: "Settle when Gemma is back. Your answer is saved.",
          },
        },
      ],
    });
    expect(html).not.toContain("How did it turn out?");
    expect(html).toContain("Gemma checks the recorded weather to score it.");
    expect(html).toContain("Settle when Gemma is back. Your answer is saved.");
  });

  it("renders without data while loading", () => {
    expect(slipsHtml(undefined)).toContain("Loading");
  });

  it("the tab bar links Today and Slips and marks the current screen", () => {
    const html = renderToStaticMarkup(<Nav flags={{}} current="slips" />);
    expect(html).toContain('href="#/today"');
    expect(html).toContain('href="#/slips" aria-current="page"');
  });
});

describe("Undo and I'll do it on Today (AC-006.3 to AC-006.5)", () => {
  const today = {
    now: "2026-10-22T08:01:00.000Z",
    flags: {},
    points: { total: 0 },
    gemma: { status: "online" as const, detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
    forecast: null,
    week: emptyWeek,
    attribution: "Weather data by Open-Meteo.com",
    cards: [],
    open_bets: [bet],
    due_bets: [],
  };

  function html(open: Bet): string {
    return renderToStaticMarkup(
      <TodayScreen
        today={{ ...today, open_bets: [open] }}
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
        onSettle={() => undefined}
        onUndo={() => undefined}
      />,
    );
  }

  it("AC-006.4: offers Undo with the minutes left while the server says undoable", () => {
    expect(html(bet)).toContain("Undo (4 min left)");
  });

  it("AC-006.5: does not offer Undo once the server says locked, or the window ran out here", () => {
    expect(html({ ...bet, undoable: false })).not.toContain("Undo");
    expect(undoMinutesLeft(bet, Date.parse(bet.undo_until) + 1)).toBeUndefined();
    expect(undoMinutesLeft(bet, Date.parse(bet.undo_until))).toBe(1);
  });

  it("AC-006.3: a card offers I'll do it next to the bet", () => {
    const withCard = renderToStaticMarkup(
      <TodayScreen
        today={{
          ...today,
          open_bets: [],
          cards: [
            {
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
                source: "rule",
                band: 3,
                band_name: "likely",
                odds: 70,
                reason: "Rule: rain.",
                settle_at: "2026-10-23T06:00:00.000Z",
                label: "Rule odds",
                provisional: false,
                payouts,
              },
            },
          ],
        }}
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
        onSettle={() => undefined}
        onUndo={() => undefined}
      />,
    );
    expect(withCard).toContain("Bet: do nothing");
    expect(withCard).toContain("I&#x27;ll do it");
    expect(withCard).toContain("+5 if the weather would not have helped");
  });
});

describe("formatTimeLeft", () => {
  it.each([
    [-1, "now"],
    [0, "now"],
    [30_000, "less than a minute"],
    [60_000, "1 min"],
    [61_000, "2 min"],
    [59 * 60_000, "59 min"],
    [3_600_000, "1 h"],
    [4 * 3_600_000 + 12 * 60_000, "4 h 12 min"],
    [26 * 3_600_000, "1 d 2 h"],
  ])("%d ms is %s", (milliseconds, text) => {
    expect(formatTimeLeft(milliseconds)).toBe(text);
  });
});

class FakeDocument implements VisibilitySource {
  visibilityState: DocumentVisibilityState = "visible";
  private listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

describe("AC-007.2 and design: polling every 30 s while visible", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes at once, then every 30 s, and stops when told to", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const doc = new FakeDocument();
    const stop = startPolling(refresh, doc);
    expect(POLL_INTERVAL_MS).toBe(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(doc.listenerCount).toBe(0);
  });

  it("makes no request while the page is hidden and refreshes when it becomes visible", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const doc = new FakeDocument();
    doc.visibilityState = "hidden";
    const stop = startPolling(refresh, doc);
    vi.advanceTimersByTime(5 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    doc.setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    doc.setVisibility("hidden");
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("estimates the server clock from its last answer", () => {
    const base = { serverMs: 1_000_000, localMs: 50 };
    expect(estimateServerNow(base, 50)).toBe(1_000_000);
    expect(estimateServerNow(base, 30_050)).toBe(1_030_000);
  });
});

describe("Settle screen (REQ-008)", () => {
  const dueBet = { ...bet, status: "due", undoable: false };

  function due(settle: Bet["settle"], extra: Partial<Bet> = {}): string {
    return slipsHtml({ ...emptySlips, settle_now: [{ ...dueBet, ...extra, settle }] });
  }

  it("AC-008.1, AC-008.3: shows the recorded weather, a tap per answer and the photo option", () => {
    const html = renderToStaticMarkup(
      <SlipsScreen
        slips={{ ...emptySlips, settle_now: [{ ...dueBet, settle: answerNeeded }] }}
        flags={{}}
        nowMs={NOW}
        busy={false}
        notice={undefined}
        onSettle={() => undefined}
        onSettlePhoto={() => undefined}
        onSettleAnswer={() => undefined}
        onUndo={() => undefined}
      />,
    );
    expect(html).toContain("Modelled recent weather (Open-Meteo)");
    expect(html).toContain("Rain 3 mm, 6 wet h");
    expect(html).toContain("17 to 19 °C");
    expect(html).toContain("Still moist, all fine");
    expect(html).toContain("Add an after photo for full points");
    expect(html).toContain("half points");
  });

  it("AC-008.5: shows the judge's question as Yes and No", () => {
    const html = due({
      ...answerNeeded,
      state: "question",
      question: "Did it rain on the balcony overnight?",
      answered_with: "tap",
    });
    expect(html).toContain("Did it rain on the balcony overnight?");
    expect(html).toContain(">Yes<");
    expect(html).toContain(">No<");
    expect(html).not.toContain("How did it turn out?");
  });

  it("AC-008.1: says when the recorded weather is not in yet", () => {
    const html = due({ ...answerNeeded, weather: null });
    expect(html).toContain("The recorded weather is not in yet.");
  });

  it("AC-008.8: a bet that waits for Gemma says so in words, without answer buttons", () => {
    const html = due({
      ...answerNeeded,
      state: "waiting_gemma",
      answered_with: "tap",
      note: "Settle when Gemma is back. Your answer is saved.",
    });
    expect(html).toContain("Settle when Gemma is back");
    expect(html).not.toContain("How did it turn out?");
  });

  it("AC-010.1, AC-010.2: a settled bet opens its receipt or its loss result on Slips", () => {
    const html = slipsHtml({
      ...emptySlips,
      settled: [
        {
          ...bet,
          id: 3,
          status: "settled",
          result: {
            verdict: "win",
            points: 15,
            evidence: "tap",
            settled_at: winReceipt.settled_at,
          },
          receipt: winReceipt,
        },
        {
          ...bet,
          id: 9,
          status: "settled",
          result: {
            verdict: "normal_loss",
            points: -50,
            evidence: "tap",
            settled_at: winReceipt.settled_at,
          },
          receipt: lossReceipt,
        },
      ],
    });
    expect(html).toContain("PAID OUT");
    expect(html).toContain("Receipt");
    expect(html).toContain("−50");
    expect(html).toContain("The weather did not cover this one");
    expect(html.match(/PAID OUT/g)).toHaveLength(1);
  });
});

describe("T-017: the stamp animation on the Slips screen", () => {
  const settledWin = (id: number, settledAt: string): Slips["settled"][number] => ({
    ...bet,
    id,
    status: "settled",
    result: { verdict: "win", points: 15, evidence: "tap", settled_at: settledAt },
    receipt: { ...winReceipt, bet_id: id, settled_at: settledAt },
  });
  const settledToday = settledWin(3, "2026-10-22T06:05:00.000Z");
  const settledEarlier = settledWin(4, "2026-10-21T06:05:00.000Z");

  function html(flags: Record<string, boolean>, settled: Slips["settled"]): string {
    return renderToStaticMarkup(
      <SlipsScreen
        slips={{ ...emptySlips, settled }}
        flags={flags}
        nowMs={NOW}
        busy={false}
        notice={undefined}
        onSettle={() => undefined}
        onUndo={() => undefined}
      />,
    );
  }

  it("AC-017.1: with the flag on, a win settled today animates and an older receipt stays static", () => {
    const result = html({ stampAnimation: true }, [settledToday, settledEarlier]);
    expect(result.match(/stamp stamp-animated/g)).toHaveLength(1);
    expect(result.match(/<p class="stamp">PAID OUT<\/p>/g)).toHaveLength(1);
  });

  it("with the flag off, no stamp animates on Slips", () => {
    const result = html({ stampAnimation: false }, [settledToday, settledEarlier]);
    expect(result).not.toContain("stamp-animated");
    expect(html({}, [settledToday])).not.toContain("stamp-animated");
    expect(result.match(/<p class="stamp">PAID OUT<\/p>/g)).toHaveLength(2);
  });
});
