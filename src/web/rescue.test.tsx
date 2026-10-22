import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { betSchema, receiptSchema, type Bet, type Slips } from "./api.js";
import { SlipsScreen } from "./SlipsScreen.js";
import { winReceipt } from "./test-data.js";

const NOW = Date.parse("2026-10-22T08:01:00.000Z");

const payouts = {
  win_with_photo: 30,
  win_with_tap: 15,
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
  do_it_if_not_needed: 5,
  do_it_if_needed: -10,
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
  undoable: false,
  settle_at: "2026-10-23T06:00:00.000Z",
  status: "open",
  payouts,
  tap_answers: [],
  settle: null,
};

const alertText =
  "The forecast turned against this bet: unlikely (35%) for the rest of the window, down from likely (70%) when you bet.";

const alertBet: Bet = {
  ...bet,
  rescue: {
    can_cash_out: true,
    cash_out_points: -10,
    checked_at: "2026-10-22T08:00:00.000Z",
    alert: {
      text: alertText,
      rule_band: 1,
      rule_band_name: "unlikely",
      rule_odds: 35,
      checked_at: "2026-10-22T08:00:00.000Z",
      forecast_at: "2026-10-22T07:50:00.000Z",
    },
  },
};

function html(slips: Slips, onCashOut?: (betId: number) => void): string {
  return renderToStaticMarkup(
    <SlipsScreen
      slips={slips}
      flags={{}}
      nowMs={NOW}
      busy={false}
      notice={undefined}
      onSettle={() => undefined}
      onUndo={() => undefined}
      {...(onCashOut === undefined ? {} : { onCashOut })}
    />,
  );
}

const slipsWith = (waiting: Bet[]): Slips => ({
  now: "2026-10-22T08:01:00.000Z",
  settle_now: [],
  settled: [],
  waiting: waiting.map((entry) => ({ ...entry, time_left_ms: 22 * 3_600_000 })),
});

describe("rescue alert and Cash out on the slip (REQ-022)", () => {
  it("AC-022.1: shows the rescue alert and the Cash out price on a waiting bet", () => {
    const page = html(slipsWith([alertBet]), () => undefined);
    expect(page).toContain("Rescue alert.");
    expect(page).toContain("turned against this bet");
    expect(page).toContain("Cash out (−10 points)");
  });

  it("AC-022.2: offers Cash out without an alert, as a plain button", () => {
    const quiet: Bet = { ...alertBet, rescue: { ...alertBet.rescue!, alert: null } };
    const page = html(slipsWith([quiet]), () => undefined);
    expect(page).not.toContain("Rescue alert.");
    expect(page).toContain("Cash out (−10 points)");
  });

  it("AC-029.2: a bet without the rescue block, or a screen without the handler, shows neither", () => {
    expect(html(slipsWith([bet]), () => undefined)).not.toContain("Cash out");
    expect(html(slipsWith([alertBet]))).not.toContain("Cash out");
    expect(html(slipsWith([alertBet]))).not.toContain("Rescue alert.");
  });

  it("AC-022.2: lists a cashed-out bet under Settled with -10", () => {
    const cashOutReceipt = receiptSchema.parse({
      ...winReceipt,
      outcome: "cash_out",
      verdict: "cash_out",
      verdict_title: "Cashed out",
      stamp: null,
      points: -10,
      total_points: -10,
      multiplier: 1,
      evidence: { kind: "none", text: "Cashed out before the settle time: no evidence needed" },
      answer: null,
      weather: null,
      gemma_read: null,
      lucky_win: null,
      message: "You folded early.",
      saved: null,
    });
    const page = html({
      ...slipsWith([]),
      settled: [
        {
          ...bet,
          status: "cashed_out",
          result: {
            verdict: "cash_out",
            points: -10,
            evidence: "none",
            settled_at: "2026-10-22T08:00:30.000Z",
          },
          receipt: cashOutReceipt,
        },
      ],
    });
    expect(page).toContain("Cashed out");
    expect(page).toContain("−10");
  });

  it("the bet schema accepts the server's rescue block and a bet without it", () => {
    expect(betSchema.parse(alertBet).rescue?.alert?.rule_band_name).toBe("unlikely");
    expect(betSchema.parse(bet).rescue).toBeUndefined();
  });
});
