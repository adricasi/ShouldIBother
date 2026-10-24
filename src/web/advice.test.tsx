// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  window: { from: "2026-10-23T12:00:00.000Z", to: "2026-10-24T00:00:00.000Z" },
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
    expect(html).toContain("Window:");
    expect(html).toContain("(Madrid time)");
    expect(html).toContain("Gemma&#x27;s advice");
    expect(html).toContain("This is advice, not a bet.");
    // No odds, payouts or bet buttons on an advice card.
    expect(html).not.toContain("Bet on doing nothing");
    expect(html).not.toMatch(/Retry Gemma/);
  });

  it("AC-031.1: shows the forecast numbers of the window", () => {
    const html = screen(today([adviceCard()]));
    expect(html).toContain("Forecast for this window (1 h)");
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
            reason: "Rule: rain in the next 48 hours; wait until 6 hours after the last wet hour.",
          },
        }),
      ]),
    );
    expect(html).toContain("Rule advice: Clean the windows after Friday 20:00");
    expect(html).toContain("Rule: rain in the next 48 hours");
  });

  it("AC-031.2: with Gemma away the card says Rule advice and offers Retry", () => {
    const html = screen(
      today([
        adviceCard({
          source: "rule",
          label: "Rule advice",
          reason: "Rule: no gusts of 40 km/h or more in the next 24 hours.",
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
          label: "Gemma is thinking · rule advice",
          decision: null,
          forecast: [],
        }),
      ]),
    );
    expect(html).toContain("Gemma is thinking · rule advice");
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
            reason: "Rule: no rain in the next 48 hours.",
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

  it("the Retry button and the disclosure summary take their 44 px from the tap token", () => {
    const styles = [
      readFileSync(join(process.cwd(), "src/web/styles.css"), "utf8"),
      readFileSync(join(process.cwd(), "src/web/gemma.css"), "utf8"),
      readFileSync(join(process.cwd(), "docs/design/tokens.css"), "utf8"),
    ].join("\n");
    expect(styles).toMatch(/--tap-min:\s*44px/);
    expect(styles).toMatch(/\.button\s*\{[^}]*min-height:\s*var\(--tap-min\)/);
    expect(styles).toMatch(/\.how-gemma summary\s*\{[^}]*min-height:\s*var\(--tap-min\)/);
    const html = screen(
      today([adviceCard({ source: "rule", label: "Rule advice", can_retry: true })]),
    );
    expect(html).toMatch(/class="button secondary compact"/);
    expect(html).toContain('class="how-gemma');
  });
});
