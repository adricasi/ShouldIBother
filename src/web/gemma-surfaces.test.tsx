// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { Bet, Card, Decision, Receipt, Today } from "./api.js";
import { WaitingLine } from "./BetParts.js";
import { BandsSideBySide, formatLatency, HowGemmaDecided, OddsWho } from "./GemmaParts.js";
import { ReceiptCard } from "./SettleParts.js";
import { emptyWeek, winReceipt } from "./test-data.js";
import { gemmaDisplayName, gemmaStatusText } from "./TodayParts.js";
import { TodayScreen } from "./TodayScreen.js";

const likely = { band: 3, band_name: "likely", odds: 70 };
const tossUp = { band: 2, band_name: "toss-up", odds: 50 };

const decision: Decision = {
  job: "bookmaker",
  model: "gemma4:e4b",
  fake: false,
  digest: "3f9a1c2d4e5f",
  prompt_version: "bookmaker.v2",
  tool_mode: "called",
  forecast: [
    { hour: "09:00", rain_mm: 0, rain_prob_pct: 5, temp_c: 21, wind_kmh: 12, sunshine_min: 58 },
    {
      hour: "10:00",
      rain_mm: 0.4,
      rain_prob_pct: 40,
      temp_c: 22,
      wind_kmh: 14,
      sunshine_min: null,
    },
  ],
  retries: 1,
  latency_ms: 2400,
};

describe("AC-028.3: whose odds these are", () => {
  it("says Gemma's odds or Rule odds from odds_source", () => {
    const gemma = renderToStaticMarkup(<OddsWho source="gemma" gemma={likely} rule={likely} />);
    expect(gemma).toContain("Gemma&#x27;s odds");
    expect(gemma).not.toContain("Rule:");
    const rule = renderToStaticMarkup(<OddsWho source="rule" gemma={null} rule={tossUp} />);
    expect(rule).toContain("Rule odds");
    expect(rule).not.toContain("Gemma&#x27;s odds");
    expect(renderToStaticMarkup(<OddsWho source={undefined} gemma={null} rule={undefined} />)).toBe(
      "",
    );
  });

  it("shows both bands side by side only when Gemma's differs from the rule's", () => {
    const html = renderToStaticMarkup(<OddsWho source="gemma" gemma={likely} rule={tossUp} />);
    expect(html).toContain("Gemma: likely 70% · Rule: toss-up 50%");
    const same = renderToStaticMarkup(<BandsSideBySide gemma={likely} rule={likely} />);
    expect(same).toBe("");
    const differs = renderToStaticMarkup(<BandsSideBySide gemma={likely} rule={tossUp} />);
    expect(differs).toContain("Gemma: likely 70%");
    expect(differs).toContain("Rule: toss-up 50%");
    expect(renderToStaticMarkup(<BandsSideBySide gemma={likely} rule={undefined} />)).toBe("");
  });
});

describe("AC-028.4: How Gemma decided", () => {
  it("is a native disclosure with the model, digest, prompt, tool mode, retries, latency and the hours", () => {
    const html = renderToStaticMarkup(<HowGemmaDecided decisions={[{ decision }]} />);
    expect(html).toContain('<details class="how-gemma">');
    expect(html).toContain("How Gemma decided");
    for (const text of [
      "gemma4:e4b",
      "3f9a1c2d4e5f",
      "bookmaker.v2",
      "Gemma called get_forecast",
      "2.4 s",
      "The forecast the tool returned to Gemma",
      "09:00",
      "10:00",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/Retries<\/dt><dd>1</);
    expect(html).not.toContain("fake model");
  });

  it("says the fake model is not Gemma", () => {
    const html = renderToStaticMarkup(
      <HowGemmaDecided
        decisions={[{ decision: { ...decision, model: "fake-gemma", fake: true } }]}
      />,
    );
    expect(html).toContain("fake-gemma (fake model: recorded test answers, not Gemma)");
  });

  it("words each tool mode, and a job without the tool", () => {
    const words = (tool_mode: Decision["tool_mode"]): string =>
      renderToStaticMarkup(
        <HowGemmaDecided decisions={[{ decision: { ...decision, tool_mode } }]} />,
      );
    expect(words("injected")).toContain("Forecast injected");
    expect(words("missed")).toContain("Gemma missed the forecast tool → retry");
    expect(words(null)).toContain("Not used by this job");
  });

  it("shows nothing without a decision, and skips the digest and the table when there are none", () => {
    expect(renderToStaticMarkup(<HowGemmaDecided decisions={[{ decision: null }]} />)).toBe("");
    expect(renderToStaticMarkup(<HowGemmaDecided decisions={[{ decision: undefined }]} />)).toBe(
      "",
    );
    const bare = renderToStaticMarkup(
      <HowGemmaDecided decisions={[{ decision: { ...decision, digest: null, forecast: null } }]} />,
    );
    expect(bare).not.toContain("Digest");
    expect(bare).not.toContain("<table");
  });

  it("formats latency in words", () => {
    expect(formatLatency(820)).toBe("820 ms");
    expect(formatLatency(1000)).toBe("1 s");
    expect(formatLatency(12_349)).toBe("12.3 s");
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

const card: Card = {
  id: 1,
  chore_type: "plants",
  title: "Water plants",
  created_at: "2026-10-22T08:00:00.000Z",
  kind: "weather",
  alert_reason: null,
  notice: null,
  gemma: { state: "answered", question: null, note: null, can_retry: false },
  quote: {
    id: 1,
    source: "gemma",
    ...likely,
    reason: "Rain is coming tonight.",
    settle_at: "2026-10-23T06:00:00.000Z",
    label: "Gemma's odds",
    provisional: false,
    payouts,
  },
  rule: tossUp,
  decision,
};

const today = (cards: Card[]): Today => ({
  now: "2026-10-22T08:00:00.000Z",
  flags: {},
  points: { total: 0 },
  gemma: { status: "online", detail: "gemma4:e4b", checked_at: "2026-10-22T08:00:00.000Z" },
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

describe("the slip", () => {
  it("AC-028.3: shows both bands when Gemma's differs from the rule's, and Gemma's reason beside them", () => {
    const html = screen(today([card]));
    expect(html).toContain("Gemma: likely 70%");
    expect(html).toContain("Rule: toss-up 50%");
    expect(html).toContain("Rain is coming tonight.");
    expect(html).toContain("Gemma&#x27;s odds");
  });

  it("AC-028.3: shows no comparison when the bands agree, nor on rule odds", () => {
    expect(screen(today([{ ...card, rule: likely }]))).not.toContain("Rule: ");
    const rule = { ...card.quote!, source: "rule" as const, label: "Gemma offline · rule odds" };
    const html = screen(today([{ ...card, quote: rule, decision: null }]));
    expect(html).not.toContain("Gemma: ");
    expect(html).toContain("rule odds");
    expect(html).not.toContain("How Gemma decided");
  });

  it("AC-028.4: offers the disclosure on the slip", () => {
    const html = screen(today([card]));
    expect(html).toContain("How Gemma decided");
    expect(html).toContain("Gemma called get_forecast");
  });
});

describe("Today's Gemma status line (design.md Round 3, item 17)", () => {
  it("names the model from the configured tag and says it runs on this laptop", () => {
    expect(gemmaDisplayName("gemma4:e4b")).toBe("Gemma 4 E4B");
    expect(gemmaDisplayName("gemma4:e2b")).toBe("Gemma 4 E2B");
    expect(gemmaDisplayName("gemma4")).toBe("Gemma 4");
    // A tag it does not know is shown as it is, never dressed up as Gemma.
    expect(gemmaDisplayName("llama3:8b")).toBe("llama3:8b");
    expect(screen(today([]))).toContain("Gemma 4 E4B · on this laptop");
  });

  it("keeps the fake model, waking and offline states as they were", () => {
    const at = "2026-10-22T08:00:00.000Z";
    expect(gemmaStatusText({ status: "online", detail: "fake model", checked_at: at })).toBe(
      "Gemma is online (fake model)",
    );
    expect(gemmaStatusText({ status: "online", detail: null, checked_at: at })).toBe(
      "Gemma is online",
    );
    expect(gemmaStatusText({ status: "waking", detail: "loading the model", checked_at: at })).toBe(
      "Gemma is waking up",
    );
    expect(
      gemmaStatusText({ status: "offline", detail: "Ollama is not answering", checked_at: at }),
    ).toBe("Gemma is offline, rule odds only");
  });
});

const bet: Bet = {
  id: 7,
  card_id: 1,
  title: "Water plants",
  chore_type: "plants",
  kind: "do_nothing",
  ...likely,
  odds_source: "gemma",
  reason: "Rain is coming tonight.",
  placed_at: "2026-10-22T08:00:00.000Z",
  undo_until: "2026-10-22T08:05:00.000Z",
  undoable: false,
  settle_at: "2026-10-23T06:00:00.000Z",
  status: "open",
  payouts,
  tap_answers: [],
  settle: null,
  rule: tossUp,
  gemma: likely,
  decision,
};

describe("waiting bets and receipts", () => {
  const waiting = (value: Bet): string =>
    renderToStaticMarkup(
      <ul>
        <WaitingLine
          bet={value}
          nowMs={Date.parse("2026-10-22T09:00:00.000Z")}
          busy={false}
          onUndo={() => undefined}
        />
      </ul>,
    );

  it("AC-028.3: a waiting bet says whose odds, with both bands when they differ", () => {
    const html = waiting(bet);
    expect(html).toContain("Gemma&#x27;s odds");
    expect(html).toContain("Gemma: likely 70% · Rule: toss-up 50%");
    // The AC-007 line is unchanged.
    expect(html).toContain("Likely · 70% · settles");
  });

  it("AC-028.3: a bet on rule odds says Rule odds", () => {
    const html = waiting({ ...bet, odds_source: "rule", gemma: null, decision: null });
    expect(html).toContain("Rule odds");
    expect(html).not.toContain("Gemma&#x27;s odds");
  });

  const receipt: Receipt = {
    ...winReceipt,
    odds_source: "gemma",
    rule: tossUp,
    gemma: likely,
    odds_reason: "Rain is coming tonight.",
    decisions: {
      odds: decision,
      verdict: { ...decision, job: "judge", prompt_version: "judge.v2" },
    },
  };

  it("AC-028.3, AC-028.4: the receipt says whose odds and offers both decisions", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={receipt} />);
    expect(html).toContain("Gemma&#x27;s odds");
    expect(html).toContain("Gemma: likely 70% · Rule: toss-up 50%");
    expect(html).toContain("Set the odds");
    expect(html).toContain("Judged the result");
    expect(html).toContain("judge.v2");
  });

  it("a receipt from before these fields existed still renders, without a disclosure", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={winReceipt} />);
    expect(html).not.toContain("How Gemma decided");
  });
});

describe("axe: the slip with the disclosure", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("has no violations, with the disclosure open", async () => {
    document.documentElement.lang = "en";
    document.title = "Today · Should I Bother?";
    document.body.innerHTML = screen(today([card])).replace(
      '<details class="how-gemma">',
      '<details class="how-gemma" open="">',
    );
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});
