// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { scoreSchema, type Score, type Today } from "./api.js";
import { ScoreScreen } from "./ScoreScreen.js";
import { emptyScore, emptyWeek, koala, lockedAchievements } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";

const screen = (score: Score) =>
  renderToStaticMarkup(
    <ScoreScreen score={score} flags={{ score: true, ranks: true }} notice={undefined} />,
  );

const withRank: Score = {
  ...emptyScore,
  points: { total: 450 },
  rank: koala,
  achievements: lockedAchievements,
};

describe("AC-025.1: the rank hero on Score", () => {
  it("AC-025.1: shows the rank name and how far the next rank is", () => {
    const html = screen(withRank);
    expect(html).toContain("Your rank");
    expect(html).toMatch(/<h2 id="rank-title"[^>]*>Koala<\/h2>/);
    expect(html).toContain("+450 points. 150 points to go for Three-toed sloth (600).");
  });

  it("AC-025.1: the progress bar is decorative and the words carry the figure", () => {
    const html = screen(withRank);
    expect(html).toContain('class="bar-track rank-bar" aria-hidden="true"');
    // 450 is 250 of the 400 points between Koala (200) and Three-toed sloth (600).
    expect(html).toContain("width:62.5%");
  });

  it("AC-025.1: the top rank has no next step", () => {
    const html = screen({
      ...withRank,
      points: { total: 2000 },
      rank: {
        id: "grand_master_of_inaction",
        name: "Grand master of inaction",
        min_points: 1800,
        next: null,
      },
    });
    expect(html).toContain("Grand master of inaction");
    expect(html).toContain("You are at the top rank.");
    expect(html).not.toContain("to go for");
  });

  it("AC-025.1: a negative total still reads as a rank and a real minus sign", () => {
    const html = screen({
      ...withRank,
      points: { total: -40 },
      rank: {
        id: "hyperactive_squirrel",
        name: "Hyperactive squirrel",
        min_points: 0,
        next: { name: "Koala", min_points: 200, points_to_go: 240 },
      },
    });
    expect(html).toContain("Hyperactive squirrel");
    expect(html).toContain("−40 points. 240 points to go for Koala (200).");
    expect(html).toContain("width:0%");
  });

  it("AC-029.2: without a rank in the response (flag off) there is no hero and no achievements", () => {
    const html = screen(emptyScore);
    expect(html).not.toContain("Your rank");
    expect(html).not.toContain("Achievements");
  });
});

describe("AC-025.2: achievements on Score", () => {
  it("AC-025.2: lists the four with their conditions, all locked at the start", () => {
    const html = screen(withRank);
    const document_ = new DOMParser().parseFromString(html, "text/html");
    const items = [...document_.querySelectorAll(".achievements li")];
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "First nap",
      "Cloud whisperer",
      "Sky freeloader",
      "Knows when to fold",
    ]);
    expect(items.every((item) => item.classList.contains("locked"))).toBe(true);
    expect(items.every((item) => item.textContent?.includes("Locked"))).toBe(true);
    expect(items[1]?.textContent).toContain("Win a bet at odds of 40% or less");
  });

  it("AC-025.2: an unlocked achievement says when, in Madrid time, and is not marked locked", () => {
    const html = screen({
      ...withRank,
      achievements: lockedAchievements.map((item) =>
        item.id === "first_nap" ? { ...item, unlocked_at: "2026-10-22T06:05:00.000Z" } : item,
      ),
    });
    const document_ = new DOMParser().parseFromString(html, "text/html");
    const first = document_.querySelector(".achievements li")!;
    expect(first.classList.contains("unlocked")).toBe(true);
    expect(first.textContent).toContain("Unlocked Thu 22 Oct, 08:05");
    expect(first.textContent).not.toContain("Locked");
    expect(document_.querySelectorAll(".achievements li.locked")).toHaveLength(3);
  });

  it("the server's rank and achievements parse with the web schema; their absence parses too", () => {
    expect(scoreSchema.parse(JSON.parse(JSON.stringify(withRank))).rank?.name).toBe("Koala");
    expect(scoreSchema.parse(JSON.parse(JSON.stringify(emptyScore))).achievements).toBeUndefined();
  });
});

describe("AC-016.3: the heater chip on Today", () => {
  const today = (flags: Record<string, boolean>): Today => ({
    now: "2026-10-22T08:00:00.000Z",
    flags,
    points: { total: 0 },
    gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
    forecast: null,
    week: emptyWeek,
    attribution: "Weather data by Open-Meteo.com",
    cards: [],
    open_bets: [],
    due_bets: [],
  });
  const html = (flags: Record<string, boolean>, onQuickCard = () => undefined) =>
    renderToStaticMarkup(
      <TodayScreen
        today={today(flags)}
        busy={false}
        notice={undefined}
        results={{}}
        nowMs={Date.parse("2026-10-22T08:01:00.000Z")}
        onQuickCard={onQuickCard}
        onCapture={() => Promise.resolve(true)}
        onRetry={() => undefined}
        onAnswer={() => undefined}
        onBet={() => undefined}
        onDoIt={() => undefined}
        onUndo={() => undefined}
        onSettle={() => undefined}
      />,
    );

  it("AC-016.3: the Skip the heater chip is there only while the heater flag is on", () => {
    expect(html({ heater: true })).toContain("Skip the heater");
    expect(html({ heater: false })).not.toContain("Skip the heater");
    expect(html({})).not.toContain("Skip the heater");
  });
});

describe("Score look (mockup 08)", () => {
  it("names the rank's place among the four and prints the points big, hidden from readers", () => {
    const html = screen(withRank);
    expect(html).toContain("Your rank · 2 of 4");
    expect(html).toContain('<p class="rank-points" aria-hidden="true">450 <span>points</span></p>');
    // An id the app does not know shows no number rather than a wrong one.
    const unknown = screen({ ...withRank, rank: { ...koala, id: "mystery" } });
    expect(unknown).toContain("Your rank<");
    expect(unknown).not.toMatch(/Your rank · \d of 4/);
  });

  it("an unlocked achievement is a sun badge with its own glyph; a locked one shows a lock", () => {
    const html = screen({
      ...withRank,
      achievements: lockedAchievements.map((item) =>
        item.id === "first_nap" ? { ...item, unlocked_at: "2026-10-22T06:05:00.000Z" } : item,
      ),
    });
    const items = [
      ...new DOMParser().parseFromString(html, "text/html").querySelectorAll(".achievements li"),
    ];
    expect(items[0]?.querySelector(".badge svg")?.getAttribute("class")).toContain("lucide-sun");
    expect(items[1]?.querySelector(".badge svg")?.getAttribute("class")).toContain("lucide-lock");
  });

  it("shows four icon tiles with the figure before the label in the layout and the label first in the markup", () => {
    const html = screen(withRank);
    expect(html).toMatch(/<dt>Chores skipped<\/dt><dd>0<\/dd>/);
    expect(html.match(/class="stat-tiles score-tiles"/g)).toHaveLength(1);
    expect(html).toContain("lucide-zap");
  });
});
