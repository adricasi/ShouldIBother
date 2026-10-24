// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { cardSchema, type Advice, type Card, type Today } from "./api.js";
import { ROUTE_TITLES } from "./route.js";
import { emptyWeek } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";

const decision = {
  job: "advisor",
  model: "gemma4:e4b",
  fake: false,
  digest: "3f9a1c2d4e5f",
  prompt_version: "advisor.v1",
  tool_mode: "called" as const,
  forecast: [
    {
      hour: "09:00",
      rain_mm: 1,
      rain_prob_pct: 80,
      temp_c: 17,
      wind_kmh: 12,
      sunshine_min: 0,
    },
  ],
  retries: 0,
  latency_ms: 4200,
};

const baseAdvice: Advice = {
  chore: "windows_clean",
  stage: "advice",
  source: "gemma",
  label: "Gemma's advice",
  advice: "wait",
  headline: "Clean the windows after Friday 14:00",
  reason: "8 mm of rain until Thursday 18:00, then dry.",
  window: { from: "2026-10-23T12:00:00.000Z", to: "2026-10-23T18:00:00.000Z" },
  rule: null,
  forecast: [
    {
      hour: "Fri 14:00",
      rain_mm: 0,
      rain_prob_pct: 5,
      temp_c: 18,
      wind_kmh: 10,
      sunshine_min: 30,
    },
  ],
  forecast_total: 12,
  note: null,
  can_retry: false,
  decision,
};

function adviceCard(advice: Partial<Advice> = {}, overrides: Partial<Card> = {}): Card {
  return {
    id: 5,
    chore_type: "windows_clean",
    title: "Clean the windows",
    created_at: "2026-10-22T07:00:00.000Z",
    kind: "weather",
    alert_reason: null,
    notice: "Clean the windows after Friday 14:00",
    quote: null,
    gemma: null,
    advice: { ...baseAdvice, ...advice },
    ...overrides,
  };
}

function today(cards: Card[]): Today {
  return {
    now: "2026-10-22T07:00:00.000Z",
    flags: { adviceCards: true },
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
    />,
  );
}

describe("AC-031.1: the advice card shows Gemma's advice and window in Madrid time with its reason", () => {
  it("AC-031.1: shows the headline, the reason and the window, and says it is not a bet", () => {
    const html = screen(today([adviceCard()]));
    expect(html).toContain("Clean the windows after Friday 14:00");
    expect(html).toContain("8 mm of rain until Thursday 18:00, then dry.");
    // One style: the date once, then the clock span, in Madrid time.
    expect(html).toContain("Fri 23 Oct, 14:00 to 20:00 (Madrid time)");
    expect(html).toContain("Gemma&#x27;s advice");
    expect(html).toContain("No bet");
    expect(html).not.toContain("This is advice, not a bet.");
    // No odds, payouts or bet buttons on an advice card.
    expect(html).not.toContain("Bet on doing nothing");
    expect(html).not.toMatch(/Retry Gemma/);
  });

  it("AC-031.1: shows the forecast numbers of the window", () => {
    const html = screen(today([adviceCard()]));
    expect(html).toContain("Forecast for this window (1 h)");
    expect(html).toContain("Rain chance %");
    expect(html).toContain("Forecast shown: 1 of 12 hours");
    expect(html).toContain('aria-label="Forecast for this window, scrollable"');
    expect(html).toContain("Fri 14:00");
  });

  it.each([
    ["windows_clean", "Clean the windows"],
    ["balcony_sweep", "Sweep the balcony"],
    ["outdoor_paint", "Paint or varnish outdoors"],
    ["lawn_feed", "Feed the lawn"],
  ] as const)("AC-031.1: %s has its own icon tile", (chore, title) => {
    const html = screen(
      today([adviceCard({ chore, headline: `${title} now` }, { chore_type: chore, title })]),
    );
    expect(html).toContain("chore-tile");
    expect(html).toContain("lucide");
  });

  it("AC-031.1: the card parses with the client schema", () => {
    expect(cardSchema.safeParse(adviceCard()).success).toBe(true);
  });
});

describe("AC-031.2: the rule advice is shown labelled, and beside Gemma's when they differ", () => {
  it("AC-031.2: shows the rule advice beside Gemma's when they differ", () => {
    const html = screen(
      today([
        adviceCard({
          rule: {
            headline: "Clean the windows after Friday 20:00",
            reason: "Rain in the next 48 hours; wait until 6 hours after the last wet hour.",
          },
        }),
      ]),
    );
    expect(html).toContain("Clean the windows after Friday 20:00");
    expect(html).toContain("Rule advice");
    expect(html).toContain("Rain in the next 48 hours");
    expect(html).not.toContain("Rule: ");
  });

  it("AC-031.2: with Gemma away the card says Rule advice and offers Retry", () => {
    const html = screen(
      today([
        adviceCard({
          source: "rule",
          label: "Rule advice",
          reason: "No gusts of 40 km/h or more in the next 24 hours.",
          note: "Gemma is not running.",
          can_retry: true,
          decision: null,
        }),
      ]),
    );
    expect(html).toContain("Rule advice");
    expect(html).toContain("Retry Gemma");
    expect(html).toContain("Gemma is not running.");
    expect(html).not.toContain("How Gemma decided");
  });

  it("AC-031.2: while Gemma thinks the rule advice is labelled as such", () => {
    const html = screen(
      today([
        adviceCard({
          source: "rule",
          label: "Rule advice · Gemma is thinking",
          decision: null,
          forecast: [],
        }),
      ]),
    );
    expect(html).toContain("Rule advice · Gemma is thinking");
    expect(html).toContain("Gemma is thinking, showing rule advice.");
    expect(html).toContain("advice-quiet");
  });

  it("AC-031.2: with no forecast the card says so and offers Retry", () => {
    const html = screen(
      today([
        adviceCard({
          stage: "unavailable",
          source: null,
          label: null,
          advice: null,
          headline: null,
          reason: null,
          window: null,
          forecast: [],
          note: "The forecast was not available.",
          can_retry: true,
          decision: null,
        }),
      ]),
    );
    expect(html).toContain("The forecast was not available.");
    expect(html).toContain("Retry Gemma");
  });
});

describe("AC-031.3: the card offers How Gemma decided", () => {
  it("AC-031.3: shows the disclosure with the advisor decision", () => {
    const html = screen(today([adviceCard()]));
    expect(html).toContain("How Gemma decided");
    expect(html).toContain("advisor.v1");
    expect(html).toContain("Gemma called get_forecast");
  });
});

describe("NFR-009: the advice card has no axe violations and keeps 44 px targets", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function violationsOf(html: string): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = ROUTE_TITLES.today;
    document.body.innerHTML = html;
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it("Gemma's advice with the rule beside it", async () => {
    const html = screen(
      today([
        adviceCard({
          rule: {
            headline: "Clean the windows now",
            reason: "No rain in the next 48 hours.",
          },
        }),
      ]),
    );
    expect(await violationsOf(html)).toEqual([]);
  });

  it("the rule advice with Retry, and the thinking and unavailable states", async () => {
    const rule = adviceCard({
      source: "rule",
      label: "Rule advice",
      note: "Gemma did not finish in time.",
      can_retry: true,
      decision: null,
    });
    const unavailable = adviceCard({
      stage: "unavailable",
      source: null,
      label: null,
      headline: null,
      reason: null,
      window: null,
      forecast: [],
      note: "The forecast was not available.",
      can_retry: true,
      decision: null,
    });
    expect(await violationsOf(screen(today([rule, { ...unavailable, id: 6 }])))).toEqual([]);
  });

  it("the Retry button and the disclosure use the shared 44 px controls", () => {
    const html = screen(
      today([adviceCard({ source: "rule", label: "Rule advice", can_retry: true })]),
    );
    // `.button` and `.how-gemma summary` take their minimum height from --tap-min (44 px).
    expect(html).toMatch(/class="button secondary compact"/);
    expect(html).toContain('class="how-gemma');
  });
});

describe("AC-031.4, AC-031.2 and AC-031.1: the other states of an advice card", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function violationsOf(html: string): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = ROUTE_TITLES.today;
    document.body.innerHTML = html;
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  const alertCard: Card = {
    id: 8,
    chore_type: "balcony_sweep",
    title: "Sweep the balcony",
    created_at: "2026-10-22T07:00:00.000Z",
    kind: "alert",
    alert_reason: "Gusts up to 85 km/h are forecast this afternoon.",
    notice: null,
    quote: null,
    gemma: null,
    advice_alert: true,
  };

  const comingLater: Card = {
    id: 9,
    chore_type: "windows_clean",
    title: "clean the windows",
    created_at: "2026-10-22T07:00:00.000Z",
    kind: "coming_later",
    alert_reason: null,
    notice: "Coming later",
    quote: null,
    gemma: null,
  };

  const unsure = adviceCard({
    source: "rule",
    label: "Rule advice",
    note: "Gemma could not decide from the forecast.",
    can_retry: true,
    window: null,
    advice: "do_now",
    headline: "Clean the windows now",
    reason: "No rain in the next 48 hours.",
  });
  const refused = adviceCard({
    source: "rule",
    label: "Rule advice",
    note: "Gemma's window was contradicted by the forecast.",
    can_retry: true,
  });
  const offline = adviceCard({
    source: "rule",
    label: "Rule advice",
    note: "Gemma is not running.",
    can_retry: true,
    decision: null,
  });

  it("AC-031.4: an advice card the safety checks turned into an alert says Not safe today, not Do it now", async () => {
    const html = screen(today([alertCard]));
    expect(html).toContain("Not safe today: Sweep the balcony");
    expect(html).toContain("Gusts up to 85 km/h");
    expect(html).not.toContain("Do it now");
    expect(await violationsOf(html)).toEqual([]);
  });

  it("AC-031.4: a plain alert still says Do it now", () => {
    const html = screen(today([{ ...alertCard, advice_alert: undefined }]));
    expect(html).toContain("Do it now: Sweep the balcony");
  });

  it("AC-031.2: unsure, refused and offline show the rule advice with the note under the label", async () => {
    for (const card of [unsure, refused, offline]) {
      const html = screen(today([card]));
      expect(html).toMatch(/Rule advice<\/p><p class="meta advice-note">/);
      expect(html).toContain("Retry Gemma");
      expect(html).toContain("Showing the rule advice, because Gemma has none.");
      expect(await violationsOf(html)).toEqual([]);
    }
  });

  it("AC-031.1: with the flag off the chore reads Coming later and has no advice", async () => {
    const html = screen({ ...today([comingLater]), flags: {} });
    expect(html).toContain("Coming later");
    expect(html).not.toContain("Lazy Bookie · Advice");
    expect(await violationsOf(html)).toEqual([]);
  });

  it("Gemma is the protagonist: its label comes above the headline, the rule's headline is quieter", () => {
    const gemma = screen(today([adviceCard()]));
    expect(gemma.indexOf("Gemma&#x27;s advice")).toBeLessThan(gemma.indexOf("<h3"));
    expect(gemma).not.toContain("advice-quiet");
    expect(gemma).toContain("Gemma&#x27;s advice is in: Clean the windows after Friday 14:00");
    const rule = screen(today([offline]));
    expect(rule.indexOf("Rule advice")).toBeLessThan(rule.indexOf("<h3"));
    expect(rule).toContain("advice-quiet");
  });

  it("names the card once when there is no headline yet, and says when the rule has no advice", () => {
    const empty = screen(
      today([
        adviceCard({
          stage: "thinking",
          source: null,
          label: null,
          headline: null,
          reason: null,
          window: null,
          forecast: [],
          note: "Gemma is checking the forecast.",
          decision: null,
        }),
      ]),
    );
    expect(empty).toContain('aria-label="Clean the windows"');
    const none = screen(
      today([adviceCard({ rule: { headline: null, reason: "No rain in the next 48 hours." } })]),
    );
    expect(none).toContain("No rule advice for this window");
  });

  it("shows no window line for a do it now", () => {
    const html = screen(
      today([
        adviceCard({
          advice: "do_now",
          headline: "Clean the windows now",
          window: null,
          forecast: [],
        }),
      ]),
    );
    expect(html).not.toContain("(Madrid time)");
  });
});
