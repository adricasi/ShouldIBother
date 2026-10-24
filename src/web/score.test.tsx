// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { scoreSchema, type CalibrationBand, type Score } from "./api.js";
import { visibleEntries, FLAGGED_ENTRIES } from "./features.js";
import { Nav } from "./Nav.js";
import { ROUTE_TITLES, redirectFor, routeOf } from "./route.js";
import { SCORE_EMPTY_TEXT, ScoreScreen, TOO_FEW_TEXT, calibrationHeadline } from "./ScoreScreen.js";
import { emptyTotals } from "./test-data.js";

const NAMES = ["very unlikely", "unlikely", "toss-up", "likely", "very likely"] as const;
const ODDS = [15, 35, 50, 70, 85] as const;

function bands(counts: readonly [n: number, wins: number][]): CalibrationBand[] {
  return counts.map(([n, wins], band) => ({
    band,
    name: NAMES[band]!,
    predicted_pct: ODDS[band]!,
    n,
    wins,
    actual_pct: n === 0 ? null : Math.round((wins / n) * 100),
    too_few: n < 5,
  }));
}

const noBets: [number, number][] = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];

const empty: Score = {
  now: "2026-10-22T08:00:00.000Z",
  points: { total: 0 },
  savings: emptyTotals,
  judge: { appeals: "off" },
  calibration: {
    settled: 0,
    gemma: bands(noBets),
    rule: bands(noBets),
    lucky_wins: { wins_labelled: 0, lucky_wins: 0, share: null, share_pct: null },
    fake_model_bets: 0,
  },
};

const populated: Score = {
  now: "2026-10-22T08:00:00.000Z",
  points: { total: 85 },
  savings: {
    bets: 12,
    wins: 8,
    time_saved_s: 7800,
    app_time_s: 360,
    net_time_s: 7440,
    water_l: 24,
    electricity_kwh: 17.6,
    assumptions: [
      {
        chore_type: "laundry_line",
        assumption: "vs a heat-pump dryer, ~2.2 kWh",
        basis: "sourced",
        wins: 8,
      },
    ],
  },
  judge: { appeals: "off" },
  calibration: {
    settled: 12,
    gemma: bands([
      [0, 0],
      [3, 1],
      [4, 2],
      [5, 4],
      [8, 7],
    ]),
    rule: bands([
      [1, 0],
      [2, 1],
      [6, 3],
      [9, 7],
      [10, 9],
    ]),
    lucky_wins: { wins_labelled: 8, lucky_wins: 2, share: 0.25, share_pct: 25 },
    fake_model_bets: 0,
  },
};

const screen = (score: Score | undefined, flags: Record<string, boolean> = { score: true }) =>
  renderToStaticMarkup(<ScoreScreen score={score} flags={flags} notice={undefined} />);

describe("Score screen (REQ-020)", () => {
  it("AC-020.1: shows total points, the four savings tiles and net time back with its note", () => {
    const html = screen(populated);
    expect(html).toContain("+85 pts");
    expect(html).toContain("Chores skipped");
    expect(html).toMatch(/Chores skipped<\/dt><dd>8</);
    expect(html).toContain("24 L");
    expect(html).toContain("17.6 kWh");
    expect(html).toContain("+2 h 4 min");
    expect(html).toContain("2 h 10 min saved, minus 6 min spent on 12 bets.");
    // Each figure carries its assumption (AC-011.5).
    expect(html).toContain("vs a heat-pump dryer, ~2.2 kWh (sourced), 8 won");
  });

  it("AC-020.1: the judge overrule rate reads 'Appeals off' while appeals are disabled", () => {
    const html = screen(populated);
    expect(html).toContain("Judge overrule rate");
    expect(html).toContain("Appeals off.");
  });

  it("AC-020.1: with appeals on it shows the rate with N", () => {
    const html = screen({
      ...populated,
      judge: { appeals: "on", n: 8, overruled: 2, rate_pct: 25 },
    });
    expect(html).toContain("25% overruled");
    expect(html).toContain("2 of 8 bets (N = 8)");
    expect(html).not.toContain("Appeals off");
  });

  it("AC-020.1: with appeals on and nothing judged it shows no percentage", () => {
    const html = screen({
      ...populated,
      judge: { appeals: "on", n: 0, overruled: 0, rate_pct: null },
    });
    expect(html).toContain("No verdicts yet");
  });

  it("AC-020.2: draws Gemma's and the rule's calibration separately, with N for every band", () => {
    const document_ = new DOMParser().parseFromString(screen(populated), "text/html");
    const charts = [...document_.querySelectorAll(".calibration")];
    expect(charts.map((chart) => chart.querySelector("h3")?.textContent)).toEqual([
      "Gemma's odds",
      "The rule's odds",
    ]);
    const nOf = (chart: Element): string[] =>
      [...chart.querySelectorAll("tbody tr")].map(
        (row) => row.querySelector("td:last-child")?.textContent?.split(" · ")[0] ?? "",
      );
    expect(nOf(charts[0]!)).toEqual(["0", "3", "4", "5", "8"]);
    expect(nOf(charts[1]!)).toEqual(["1", "2", "6", "9", "10"]);
    // Predicted odds next to what happened: "likely" promised 70%, 4 of 5 worked.
    const likely = charts[0]!.querySelectorAll("tbody tr")[3]!;
    expect(likely.textContent).toContain("likely");
    expect(likely.textContent).toContain("70%");
    expect(likely.textContent).toContain("80%");
  });

  it("AC-020.2: the lucky-win share is reported separately and wins stay wins", () => {
    const html = screen(populated);
    expect(html).toContain("Lucky wins: 2 of 8 labelled wins (25%)");
    expect(html).toContain("Every win counts, lucky wins included.");
  });

  it("AC-020.3: a band under 5 bets shows its N and 'too few to judge' instead of a figure", () => {
    const document_ = new DOMParser().parseFromString(screen(populated), "text/html");
    const gemma = document_.querySelectorAll(".calibration")[0]!;
    const rows = [...gemma.querySelectorAll("tbody tr")];
    // 3 and 4 bets: N shown, marked, no bar and no percentage.
    for (const index of [1, 2]) {
      expect(rows[index]!.textContent).toContain(TOO_FEW_TEXT);
      expect(rows[index]!.querySelector(".bar-track")).toBeNull();
    }
    expect(rows[1]!.querySelector("td:last-child")?.textContent).toContain("3");
    expect(rows[1]!.textContent).not.toMatch(/33%/);
    // Exactly 5 is enough to judge.
    expect(rows[3]!.textContent).not.toContain(TOO_FEW_TEXT);
    expect(rows[3]!.querySelector(".bar-track")).not.toBeNull();
  });

  it("AC-020.4: with no settled bets it shows the empty state and no chart", () => {
    const html = screen(empty);
    expect(html).toContain(SCORE_EMPTY_TEXT);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("calibration");
  });

  it("AC-020.3: a band with no bets shows N = 0 and 'too few to judge'", () => {
    const document_ = new DOMParser().parseFromString(screen(populated), "text/html");
    const first = document_.querySelectorAll(".calibration")[0]!.querySelector("tbody tr")!;
    expect(first.querySelector("td:last-child")?.textContent).toBe("0");
    expect(first.textContent).toContain(TOO_FEW_TEXT);
    expect(first.querySelector(".bar-track")).toBeNull();
  });

  it("AC-020.2: the lucky share is the server's whole percent, not recomputed from a float", () => {
    const html = screen({
      ...populated,
      calibration: {
        ...populated.calibration,
        lucky_wins: { wins_labelled: 40, lucky_wins: 23, share: 0.575, share_pct: 58 },
      },
    });
    expect(html).toContain("Lucky wins: 23 of 40 labelled wins (58%)");
  });

  it("AC-020.2: says why Gemma's chart is empty when every Gemma-priced bet came from the fake model", () => {
    const emptyGemma = bands(noBets);
    const fake = {
      ...populated,
      calibration: { ...populated.calibration, gemma: emptyGemma, fake_model_bets: 3 },
    };
    expect(screen(fake)).toContain("every bet Gemma priced came from the fake model");
    expect(screen(populated)).not.toContain("fake model");
    const noneFake = { ...fake, calibration: { ...fake.calibration, fake_model_bets: 0 } };
    expect(screen(noneFake)).not.toContain("fake model");
  });

  it("shows a loading line before the first answer", () => {
    expect(screen(undefined)).toContain("Loading…");
  });

  it("after a failed load shows only the alert, not 'Loading…'", () => {
    const html = renderToStaticMarkup(
      <ScoreScreen
        score={undefined}
        flags={{ score: true }}
        notice={{ kind: "error", text: "Can't reach the laptop.", origin: "poll" }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Can&#x27;t reach the laptop.");
    expect(html).not.toContain("Loading…");
  });

  it("redirects #/score to Today once the server says the score flag is off", () => {
    expect(redirectFor("score", { score: false })).toBe("#/today");
    expect(redirectFor("score", {})).toBe("#/today");
    expect(redirectFor("score", { score: true })).toBeUndefined();
    // Flags not loaded yet: wait, do not redirect.
    expect(redirectFor("score", undefined)).toBeUndefined();
    expect(redirectFor("slips", { score: false })).toBeUndefined();
  });

  it("AC-029.2: the Score tab is rendered only while the score flag is on", () => {
    const entries = FLAGGED_ENTRIES;
    expect(visibleEntries(entries, { score: false }).map((entry) => entry.id)).not.toContain(
      "score",
    );
    expect(visibleEntries(entries, { score: true }).map((entry) => entry.id)).toContain("score");
    expect(renderToStaticMarkup(<Nav flags={{}} />)).not.toContain("#/score");
    const on = renderToStaticMarkup(<Nav flags={{ score: true }} current="score" />);
    expect(on).toMatch(/href="#\/score" aria-current="page"/);
  });

  it("routes #/score to the Score screen and gives it a title", () => {
    expect(routeOf("#/score")).toBe("score");
    expect(ROUTE_TITLES.score).toBe("Score · Should I Bother?");
  });

  it("parses what the server sends: the API schema accepts both judge states", () => {
    expect(scoreSchema.safeParse(populated).success).toBe(true);
    expect(
      scoreSchema.safeParse({
        ...populated,
        judge: { appeals: "on", n: 3, overruled: 1, rate_pct: 33 },
      }).success,
    ).toBe(true);
  });
});

describe("NFR-009: Score screen accessibility (axe)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function violationsOf(html: string): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = ROUTE_TITLES.score;
    document.body.innerHTML = html;
    // jsdom has no layout, so colour contrast cannot be computed here; the tokens' contrast is
    // checked on its own (design-handoff §4) and the screen only uses the *-text variants.
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it("a populated screen has no violations", async () => {
    expect(await violationsOf(screen(populated))).toEqual([]);
  });

  it("the empty state has no violations", async () => {
    expect(await violationsOf(screen(empty))).toEqual([]);
  });

  it("the screen with appeals on has no violations", async () => {
    const html = screen({
      ...populated,
      judge: { appeals: "on", n: 8, overruled: 2, rate_pct: 25 },
    });
    expect(await violationsOf(html)).toEqual([]);
  });

  it("the loading screen has no violations", async () => {
    expect(await violationsOf(screen(undefined))).toEqual([]);
  });
});

describe("The calibration headline (mockup 08, AC-020.3)", () => {
  const band = (
    name: string,
    predicted: number,
    n: number,
    actual: number | null,
  ): CalibrationBand => ({
    band: 0,
    name,
    predicted_pct: predicted,
    n,
    wins: 0,
    actual_pct: actual,
    too_few: n < 5,
  });

  it("names the band with the most bets that has enough of them", () => {
    expect(
      calibrationHeadline([
        band("unlikely", 35, 8, 50),
        band("likely", 70, 9, 74),
        band("x", 15, 3, null),
      ]),
    ).toBe("When Gemma says 70%, doing nothing works 74% of the time (9 bets).");
  });

  it("says nothing while no band has five bets, so a shaky share is never a headline", () => {
    expect(
      calibrationHeadline([band("likely", 70, 4, 75), band("x", 15, 0, null)]),
    ).toBeUndefined();
    expect(calibrationHeadline([])).toBeUndefined();
  });
});
