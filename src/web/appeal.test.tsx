// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APPEAL_COPY, AppealAction } from "./AppealParts.js";
import { receiptSchema, type Bet, type Receipt, type Slips } from "./api.js";
import { App } from "./App.js";
import { ReceiptCard } from "./SettleParts.js";
import { emptyWeek, lossReceipt, winReceipt } from "./test-data.js";

const appealed: Receipt = {
  ...winReceipt,
  points: 30,
  can_appeal: false,
  appeal: {
    first: {
      verdict: "normal_loss",
      verdict_title: "Loss",
      points: -50,
      reason: "The soil is dry.",
      settled_at: "2026-10-23T06:05:00.000Z",
    },
    changed: true,
  },
};

describe("REQ-023: the appeal on the receipt", () => {
  it("AC-023.1: an appealed receipt shows the first verdict it replaced and says the second is final", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={appealed} />);
    expect(html).toContain("Appealed");
    expect(html).toContain("First verdict: Loss (−50).");
    expect(html).toContain("The new photo changed the verdict.");
    expect(html).toContain("Gemma first said: The soil is dry.");
    expect(html).toContain("The second verdict is final. There is no second appeal.");
  });

  it("AC-023.3: a confirmed verdict says so instead of 'changed'", () => {
    const html = renderToStaticMarkup(
      <ReceiptCard receipt={{ ...appealed, appeal: { ...appealed.appeal!, changed: false } }} />,
    );
    expect(html).toContain("The new photo confirmed the verdict.");
    expect(html).not.toContain("changed the verdict");
  });

  it("AC-029.2: a receipt without an appeal block shows no appeal text", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={lossReceipt} />);
    expect(html).not.toContain("Appealed");
    expect(html).not.toContain("appeal");
  });

  it("the receipt schema accepts the server's appeal block and a receipt without it", () => {
    expect(receiptSchema.parse(appealed).appeal?.first.points).toBe(-50);
    expect(receiptSchema.parse(winReceipt).appeal).toBeUndefined();
    expect(receiptSchema.parse({ ...winReceipt, can_appeal: true }).can_appeal).toBe(true);
  });
});

describe("REQ-023: the appeal action", () => {
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
  });

  const render = (receipt: Receipt, onAppeal = vi.fn(), busy = false): typeof onAppeal => {
    act(() => {
      root.render(<AppealAction receipt={receipt} busy={busy} onAppeal={onAppeal} />);
    });
    return onAppeal;
  };

  it("AC-023.1: offers one photo picker and sends the chosen file with the bet id", () => {
    const onAppeal = render({ ...lossReceipt, can_appeal: true });
    expect(container.textContent).toContain("Appeal with a new photo");
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input.accept).toBe("image/*");
    const file = new File(["x"], "after.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file] });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onAppeal).toHaveBeenCalledWith(lossReceipt.bet_id, file);
  });

  it("AC-023.2: offers nothing once appealed, when the server does not offer it, or with the flag off", () => {
    render(appealed);
    expect(container.textContent).toBe("");
    render({ ...lossReceipt, can_appeal: false });
    expect(container.textContent).toBe("");
    render(lossReceipt);
    expect(container.textContent).toBe("");
  });

  it("AC-023.1, AC-008.8: says appeals now pay at most half points only when the server says the appeal would be capped", () => {
    render({ ...lossReceipt, can_appeal: true, appeal_pays_half: false });
    expect(container.textContent).not.toContain(APPEAL_COPY.half);
    render({ ...lossReceipt, can_appeal: true, appeal_pays_half: true });
    expect(container.textContent).toContain("Appeals now pay at most half points.");
    expect(receiptSchema.parse({ ...winReceipt, appeal_pays_half: true }).appeal_pays_half).toBe(
      true,
    );
  });

  it("describes the picker by the offer text, and says Gemma is re-judging while the appeal runs", () => {
    render({ ...lossReceipt, can_appeal: true, appeal_pays_half: true });
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    const offer = document.getElementById(input.getAttribute("aria-describedby")!);
    expect(offer?.textContent).toContain(APPEAL_COPY.offer);
    expect(offer?.textContent).toContain(APPEAL_COPY.half);
    expect(container.textContent).not.toContain("re-judging");
    act(() => {
      root.render(
        <AppealAction
          receipt={{ ...lossReceipt, can_appeal: true }}
          busy={true}
          working={true}
          onAppeal={() => undefined}
        />,
      );
    });
    expect(container.querySelector("[role=status]")?.textContent).toBe("Gemma is re-judging…");
  });

  it("disables the picker while another request is running", () => {
    render({ ...lossReceipt, can_appeal: true }, vi.fn(), true);
    expect(container.querySelector<HTMLInputElement>("input[type=file]")!.disabled).toBe(true);
  });
});

const payouts = {
  win_with_photo: 30,
  win_with_tap: 15,
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
  do_it_if_not_needed: 5,
  do_it_if_needed: -10,
};

const settledBet: Bet & {
  result: { verdict: string; points: number; evidence: string; settled_at: string };
  receipt: Receipt;
} = {
  id: 8,
  card_id: 1,
  title: "Water plants",
  chore_type: "plants",
  kind: "do_nothing",
  band: 3,
  band_name: "likely",
  odds: 70,
  odds_source: "rule",
  reason: "Rule: 3 mm of rain expected.",
  placed_at: "2026-10-21T08:00:00.000Z",
  undo_until: "2026-10-21T08:05:00.000Z",
  undoable: false,
  settle_at: "2026-10-22T06:00:00.000Z",
  status: "settled",
  payouts,
  tap_answers: [],
  settle: null,
  result: {
    verdict: "normal_loss",
    points: -50,
    evidence: "tap",
    settled_at: "2026-10-22T06:05:00.000Z",
  },
  receipt: { ...lossReceipt, bet_id: 8, can_appeal: true, appeal_pays_half: false },
};

describe("REQ-023: appealing in the app", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = "#/slips";
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  /** The server as far as the App needs it; the appeal answers with `appealReceipt`. */
  function stubServer(appealReceipt: Receipt, flagOn = true): { calls: string[] } {
    const calls: string[] = [];
    const slips: Slips = {
      now: "2026-10-22T08:01:00.000Z",
      settle_now: [],
      waiting: [],
      settled: [settledBet],
    };
    const today = {
      now: "2026-10-22T08:01:00.000Z",
      flags: { appeals: flagOn },
      points: { total: -50 },
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
      if (path === "/api/bets/8/appeal") {
        return Promise.resolve(
          new Response(JSON.stringify({ state: "settled", receipt: appealReceipt }), {
            status: 200,
          }),
        );
      }
      const body = path === "/api/today" ? today : path === "/api/slips" ? slips : null;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: body === null ? 404 : 200 }),
      );
    });
    return { calls };
  }

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  async function pickPhoto(): Promise<void> {
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "after.jpg", { type: "image/jpeg" })],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await settle();
  }

  it("AC-023.3: a changed verdict is announced with its points and as final", async () => {
    const { calls } = stubServer({ ...appealed, bet_id: 8 });
    await act(() => {
      root.render(<App />);
      return Promise.resolve();
    });
    await settle();
    await pickPhoto();
    expect(calls.filter((call) => call === "POST /api/bets/8/appeal")).toHaveLength(1);
    expect(container.textContent).toContain(
      "Appeal decided: You win, +30 points. This verdict is final.",
    );
    // The slips are read again so the screen shows what the server now holds.
    expect(calls.filter((call) => call === "GET /api/slips").length).toBeGreaterThan(1);
  });

  it("AC-023.3: a confirmed verdict says Gemma stands by it", async () => {
    stubServer({
      ...lossReceipt,
      bet_id: 8,
      can_appeal: false,
      appeal: { ...appealed.appeal!, changed: false },
    });
    await act(() => {
      root.render(<App />);
      return Promise.resolve();
    });
    await settle();
    await pickPhoto();
    expect(container.textContent).toContain(
      "Appeal decided: Gemma stands by Loss. This verdict is final.",
    );
  });

  it("AC-029.2: with the appeals flag off the app offers no appeal", async () => {
    stubServer(appealed, false);
    await act(() => {
      root.render(<App />);
      return Promise.resolve();
    });
    await settle();
    expect(container.textContent).toContain("Water plants");
    expect(container.querySelector("input[type=file]")).toBeNull();
    expect(container.textContent).not.toContain("Appeal with a new photo");
  });
});
