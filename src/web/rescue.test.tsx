// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { betSchema, receiptSchema, type Bet, type Slips } from "./api.js";
import { App } from "./App.js";
import { RescuePanel } from "./RescueParts.js";
import { SlipsScreen } from "./SlipsScreen.js";
import { emptyWeek, winReceipt } from "./test-data.js";

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
  chore_type: "plants",
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
    // Madrid time: 08:00Z is 10:00, 07:50Z is 09:50.
    expect(page).toContain("Checked 10:00, forecast from 09:50.");
    // A warning, not an error.
    expect(page).toContain("rescue-alert");
    expect(page).not.toContain("notice error");
  });

  it("AC-022.1: the live region is in the page before any alert, so a later alert is announced", () => {
    const quiet: Bet = { ...alertBet, rescue: { ...alertBet.rescue!, alert: null } };
    const page = html(slipsWith([quiet]), () => undefined);
    expect(page).toContain('role="status"');
    expect(page).toContain('aria-live="polite"');
    expect(page).not.toContain("Rescue alert.");
  });

  it("the Cash out button names the bet it acts on, and starts with the visible words", () => {
    const page = html(slipsWith([alertBet]), () => undefined);
    expect(page).toContain('aria-label="Cash out (−10 points): Water plants"');
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

describe("Cash out interaction", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const buttons = (): string[] =>
    [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
  const click = (label: string): void => {
    const target = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
    expect(target, label).toBeDefined();
    act(() => {
      target!.click();
    });
  };

  it("AC-022.2: the first tap only asks; Yes sends the cash-out once; Keep the bet backs out", () => {
    const onCashOut = vi.fn();
    act(() => {
      root.render(<RescuePanel bet={alertBet} busy={false} onCashOut={onCashOut} />);
    });
    expect(buttons()).toEqual(["Cash out (−10 points)"]);

    click("Cash out (−10 points)");
    expect(onCashOut).not.toHaveBeenCalled();
    expect(buttons()).toEqual(["Yes, cash out", "Keep the bet"]);
    expect(container.textContent).toContain("Cash out for −10 points?");

    click("Keep the bet");
    expect(onCashOut).not.toHaveBeenCalled();
    expect(buttons()).toEqual(["Cash out (−10 points)"]);

    click("Cash out (−10 points)");
    click("Yes, cash out");
    expect(onCashOut).toHaveBeenCalledTimes(1);
    expect(onCashOut).toHaveBeenCalledWith(7);
  });

  it("disables every button while a request runs", () => {
    act(() => {
      root.render(<RescuePanel bet={alertBet} busy={true} onCashOut={() => undefined} />);
    });
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("shows nothing for a bet without a rescue block, and no button when it cannot be cashed out", () => {
    act(() => {
      root.render(<RescuePanel bet={bet} busy={false} onCashOut={() => undefined} />);
    });
    expect(container.innerHTML).toBe("");
    const closed: Bet = { ...alertBet, rescue: { ...alertBet.rescue!, can_cash_out: false } };
    act(() => {
      root.render(<RescuePanel bet={closed} busy={false} onCashOut={() => undefined} />);
    });
    expect(buttons()).toEqual([]);
  });

  async function violations(): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = "Slips · Should I Bother?";
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it("the Slips screen with an alert, asking and not asking, has no accessibility violations", async () => {
    act(() => {
      root.render(
        <SlipsScreen
          slips={slipsWith([alertBet])}
          flags={{ rescue: true }}
          nowMs={NOW}
          busy={false}
          notice={undefined}
          onSettle={() => undefined}
          onUndo={() => undefined}
          onCashOut={() => undefined}
        />,
      );
    });
    expect(await violations()).toEqual([]);
    click("Cash out (−10 points)");
    expect(await violations()).toEqual([]);
  });

  /** The server, as far as the App needs it: Today, Slips and the cash-out. */
  function stubServer(rescueOn: boolean): string[] {
    const calls: string[] = [];
    const today = {
      now: "2026-10-22T08:01:00.000Z",
      flags: { rescue: rescueOn },
      points: { total: 0 },
      week: emptyWeek,
      gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
      forecast: null,
      attribution: "Weather data by Open-Meteo.com",
      cards: [],
      open_bets: [],
      due_bets: [],
    };
    vi.stubGlobal("fetch", (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const body =
        path === "/api/today" ? today : path === "/api/slips" ? slipsWith([alertBet]) : null;
      if (path === "/api/bets/7/cashout") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              state: "cashed_out",
              receipt: {
                ...winReceipt,
                outcome: "cash_out",
                verdict: "cash_out",
                stamp: null,
                evidence: { kind: "none", text: "x" },
                points: -10,
                total_points: -10,
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: body === null ? 404 : 200 }),
      );
    });
    return calls;
  }

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  it("AC-022.2: in the app, Cash out then Yes posts to the cash-out route and reloads the slips", async () => {
    window.location.hash = "#/slips";
    const calls = stubServer(true);
    await act(() => {
      root.render(<App />);
      return Promise.resolve();
    });
    await settle();
    click("Cash out (−10 points)");
    expect(calls).not.toContain("POST /api/bets/7/cashout");
    click("Yes, cash out");
    await settle();
    expect(calls.filter((call) => call === "POST /api/bets/7/cashout")).toHaveLength(1);
    expect(container.textContent).toContain("Cashed out: minus 10 points");
    expect(calls.filter((call) => call === "GET /api/slips").length).toBeGreaterThan(1);
  });

  it("AC-029.2: in the app, with the flag off, there is no Cash out", async () => {
    window.location.hash = "#/slips";
    stubServer(false);
    await act(() => {
      root.render(<App />);
      return Promise.resolve();
    });
    await settle();
    expect(container.textContent).toContain("Water plants");
    expect(buttons().some((label) => label.startsWith("Cash out"))).toBe(false);
  });
});
