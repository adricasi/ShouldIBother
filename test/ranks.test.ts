import { afterEach, describe, expect, it } from "vitest";

import { earnedAchievements, rankFor, type BetResult } from "../src/domain/ranks.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { betResults, syncAchievements } from "../src/server/ledger/achievements.js";
import { pointsTotal } from "../src/server/ledger/points.js";
import type { Score } from "../src/server/ledger/score.js";
import { buildExport } from "../src/server/ledger/export.js";
import { scoreSchema } from "../src/web/api.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { HOUR, MINUTE, seedBet, tap } from "./support/settle.js";

const win = (at: number, odds = 70): BetResult => ({ kind: "win", at, odds });
const loss = (at: number): BetResult => ({ kind: "loss", at });
const cashOut = (at: number): BetResult => ({ kind: "cash_out", at });

describe("REQ-025: ranks (domain)", () => {
  it.each([
    [-300, "Hyperactive squirrel"],
    [0, "Hyperactive squirrel"],
    [199, "Hyperactive squirrel"],
    [200, "Koala"],
    [599, "Koala"],
    [600, "Three-toed sloth"],
    [1799, "Three-toed sloth"],
    [1800, "Grand master of inaction"],
    [25_000, "Grand master of inaction"],
  ])("AC-025.1: %i points is %s (lower bound included)", (points, name) => {
    expect(rankFor(points).name).toBe(name);
  });

  it("AC-025.1: says how far the next rank is, and nothing at the top", () => {
    expect(rankFor(150).next).toEqual({ name: "Koala", min_points: 200, points_to_go: 50 });
    expect(rankFor(-20).next).toEqual({ name: "Koala", min_points: 200, points_to_go: 220 });
    expect(rankFor(1800).next).toBeNull();
  });
});

describe("REQ-025: achievements (domain)", () => {
  it("AC-025.2: First nap is the first win, at the time of that win", () => {
    expect(earnedAchievements([loss(1), cashOut(2)]).has("first_nap")).toBe(false);
    expect(earnedAchievements([loss(1), win(5), win(9)]).get("first_nap")).toBe(5);
  });

  it("AC-025.2: Cloud whisperer is a win at odds of 40% or less; 50% does not count", () => {
    expect(earnedAchievements([win(1, 50), win(2, 70)]).has("cloud_whisperer")).toBe(false);
    expect(earnedAchievements([win(1, 50), win(2, 35), win(3, 15)]).get("cloud_whisperer")).toBe(2);
    expect(earnedAchievements([loss(1), cashOut(2)]).has("cloud_whisperer")).toBe(false);
  });

  it("AC-025.2: Sky freeloader is three wins in a row; a loss or a cash-out starts the count again", () => {
    expect(earnedAchievements([win(1), win(2)]).has("sky_freeloader")).toBe(false);
    expect(earnedAchievements([win(1), win(2), win(3)]).get("sky_freeloader")).toBe(3);
    expect(
      earnedAchievements([win(1), win(2), loss(3), win(4), win(5)]).has("sky_freeloader"),
    ).toBe(false);
    expect(
      earnedAchievements([win(1), win(2), cashOut(3), win(4), win(5)]).has("sky_freeloader"),
    ).toBe(false);
    expect(
      earnedAchievements([win(1), win(2), loss(3), win(4), win(5), win(6)]).get("sky_freeloader"),
    ).toBe(6);
  });

  it("AC-025.2: a cash-out restarts the streak: win, win, cash-out, win is not three in a row", () => {
    expect(earnedAchievements([win(1), win(2), cashOut(3), win(4)]).has("sky_freeloader")).toBe(
      false,
    );
    expect(earnedAchievements([cashOut(1), win(2), win(3), win(4)]).get("sky_freeloader")).toBe(4);
  });

  it("AC-025.2: Knows when to fold is the first cash-out", () => {
    expect(earnedAchievements([win(1), loss(2)]).has("knows_when_to_fold")).toBe(false);
    expect(earnedAchievements([win(1), cashOut(4), cashOut(7)]).get("knows_when_to_fold")).toBe(4);
  });

  it("AC-025.2: an achievement keeps its first time however long the streak runs", () => {
    const earned = earnedAchievements([win(1), win(2), win(3), win(4), win(5)]);
    expect(earned.get("sky_freeloader")).toBe(3);
    expect(earned.get("first_nap")).toBe(1);
  });
});

describe("migration 0014: achievements", () => {
  it("is number 14 (12 and 13 belong to open branches; ids only have to increase) and adds one table", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain(14);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const before = MIGRATIONS.filter((migration) => migration.id < 14);
    const db = openDatabase(":memory:");
    migrate(db, before);
    db.exec(
      "INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1)",
    );
    expect(migrate(db, MIGRATIONS)).toEqual([14]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM achievements").get()).toEqual({ n: 0 });
    expect(() =>
      db.exec("INSERT INTO achievements (id, unlocked_at) VALUES ('nope', 1)"),
    ).toThrow();
    db.close();
  });
});

describe("REQ-025: Score API", () => {
  let harness: CoreHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function setup(flags: { ranks?: boolean } = { ranks: true }): Promise<CoreHarness> {
    harness = await createCoreHarness({ flags: { score: true, rescue: true, ...flags } });
    await pair(harness);
    return harness;
  }

  async function score(h: CoreHarness): Promise<Score> {
    const response = await h.get("/api/score");
    expect(response.statusCode).toBe(200);
    return response.json<Score>();
  }

  /** Seeds a bet at the odds of `band` and settles it with a tap through the judge. */
  async function settle(h: CoreHarness, band: 0 | 1 | 2 | 3 | 4, answer: string): Promise<number> {
    h.clock.advance(MINUTE);
    const betId = seedBet(h, { band, status: "due", settleOffsetMs: -MINUTE });
    expect((await tap(h, betId, answer)).body.state).toBe("settled");
    return betId;
  }

  const unlockedIds = (body: Score): string[] =>
    (body.achievements ?? []).filter((item) => item.unlocked_at !== null).map((item) => item.id);

  it("AC-025.1: the rank follows the points total of settlements, cash-outs and advice", async () => {
    const h = await setup();
    expect((await score(h)).rank).toMatchObject({
      name: "Hyperactive squirrel",
      next: { name: "Koala", points_to_go: 200 },
    });
    h.db
      .prepare(
        "INSERT INTO cards (input_text, chore_type, kind, advice_points, created_at) VALUES ('plan', 'laundry_plan', 'weather', 5, 1)",
      )
      .run();
    await settle(h, 3, "moist"); // 70% odds, one tap: 15
    const body = await score(h);
    expect(body.points.total).toBe(pointsTotal(h));
    expect(body.points.total).toBe(20);
    expect(body.rank).toMatchObject({ id: "hyperactive_squirrel", next: { points_to_go: 180 } });
    // The Koala line is crossed by the points in the ledger, whatever they are made of.
    h.db
      .prepare(
        "INSERT INTO cards (input_text, chore_type, kind, advice_points, created_at) VALUES ('plan', 'laundry_plan', 'weather', 180, 2)",
      )
      .run();
    expect((await score(h)).rank).toMatchObject({ id: "koala", name: "Koala" });
  });

  it("AC-025.2: a first win unlocks First nap once, with the time of the settlement", async () => {
    const h = await setup();
    expect(unlockedIds(await score(h))).toEqual([]);
    await settle(h, 3, "moist");
    const settledAt = h.clock.current;
    const body = await score(h);
    expect(unlockedIds(body)).toEqual(["first_nap"]);
    expect(body.achievements?.find((item) => item.id === "first_nap")?.unlocked_at).toBe(
      new Date(settledAt).toISOString(),
    );
    // Reading again, and winning again, neither duplicates nor moves it.
    await settle(h, 3, "moist");
    expect(unlockedIds(await score(h))).toEqual(["first_nap"]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM achievements").get()).toEqual({ n: 1 });
    expect(h.db.prepare("SELECT unlocked_at FROM achievements").get()).toEqual({
      unlocked_at: settledAt,
    });
  });

  it("AC-025.2: a win at 35% odds unlocks Cloud whisperer; a loss unlocks nothing", async () => {
    const h = await setup();
    await settle(h, 1, "dry"); // a loss, whatever the odds
    expect(unlockedIds(await score(h))).toEqual([]);
    await settle(h, 1, "moist");
    expect(unlockedIds(await score(h)).sort()).toEqual(["cloud_whisperer", "first_nap"]);
  });

  it("AC-025.2: three wins in a row unlock Sky freeloader, and a loss in between delays it", async () => {
    const h = await setup();
    await settle(h, 3, "moist");
    await settle(h, 3, "moist");
    await settle(h, 3, "dry");
    await settle(h, 3, "moist");
    await settle(h, 3, "moist");
    expect(unlockedIds(await score(h))).toEqual(["first_nap"]);
    await settle(h, 3, "moist");
    expect(unlockedIds(await score(h))).toContain("sky_freeloader");
  });

  it("AC-025.2: the first cash-out unlocks Knows when to fold", async () => {
    const h = await setup();
    const id = seedBet(h, { band: 3, status: "open", settleOffsetMs: 8 * HOUR, openHours: 1 });
    expect((await h.post(`/api/bets/${id}/cashout`, {})).statusCode).toBe(200);
    const body = await score(h);
    expect(unlockedIds(body)).toEqual(["knows_when_to_fold"]);
    expect(body.points.total).toBe(-10);
    expect(body.rank?.name).toBe("Hyperactive squirrel");
  });

  it("AC-025.2: an unlocked achievement stays unlocked after the bet's data is deleted", async () => {
    const h = await setup();
    const betId = await settle(h, 3, "moist");
    expect(unlockedIds(await score(h))).toEqual(["first_nap"]);
    expect((await h.delete(`/api/bets/${betId}/data`)).statusCode).toBeLessThan(300);
    expect(unlockedIds(await score(h))).toEqual(["first_nap"]);
  });

  it("AC-025.2: a do-it decision is not a bet on doing nothing: no win, no streak step", async () => {
    const h = await setup();
    h.clock.advance(MINUTE);
    seedBet(h, { band: 3, kind: "do_it", status: "due", settleOffsetMs: -MINUTE });
    expect(await h.core.scheduler.tickSettlement()).toBe(1);
    expect(h.db.prepare("SELECT verdict FROM settlements").get()).toEqual({
      verdict: "weather_would_not",
    });
    expect(unlockedIds(await score(h))).toEqual([]);
  });

  it("AC-025.2: a win unlocks First nap at once, so deleting the bet before the Score is read keeps it", async () => {
    const h = await setup();
    const betId = await settle(h, 3, "moist");
    expect(h.db.prepare("SELECT id FROM achievements").all()).toEqual([{ id: "first_nap" }]);
    expect((await h.delete(`/api/bets/${betId}/data`)).statusCode).toBeLessThan(300);
    expect(unlockedIds(await score(h))).toEqual(["first_nap"]);
  });

  it("AC-025.2: a cash-out unlocks Knows when to fold at once, without a Score read", async () => {
    const h = await setup();
    const id = seedBet(h, { band: 3, status: "open", settleOffsetMs: 8 * HOUR, openHours: 1 });
    await h.post(`/api/bets/${id}/cashout`, {});
    expect(h.db.prepare("SELECT id FROM achievements").all()).toEqual([
      { id: "knows_when_to_fold" },
    ]);
  });

  it("AC-025.2: a Score read with nothing new does no write", async () => {
    const h = await setup();
    await settle(h, 3, "moist");
    await score(h);
    const changes = (): number =>
      (h.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    await score(h);
    await score(h);
    expect(changes()).toBe(before);
  });

  it("AC-025.2: an appeal that turns the win into a loss does not take the unlock back", async () => {
    const h = await setup();
    const betId = await settle(h, 3, "moist");
    expect(unlockedIds(await score(h))).toEqual(["first_nap"]);
    // The shape an appeal leaves (migration 0012): the first row stops being final, the appeal row is.
    const original = h.db.prepare("SELECT id FROM settlements WHERE bet_id = ?").get(betId) as {
      id: number;
    };
    h.db.prepare("UPDATE settlements SET final = 0 WHERE id = ?").run(original.id);
    h.db
      .prepare(
        `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
         VALUES (?, 'photo', 1, 'normal_loss', -50, ?, ?, 1)`,
      )
      .run(betId, h.clock.current + MINUTE, original.id);
    expect(betResults(h).map((result) => result.kind)).toEqual(["loss"]);
    const body = await score(h);
    expect(body.points.total).toBe(-50);
    expect(unlockedIds(body)).toEqual(["first_nap"]);
  });

  it("AC-025.2: a win and a cash-out settled in the same millisecond are ordered by bet id", async () => {
    const h = await setup();
    const seedSettled = (verdict: "win" | "cash_out"): number => {
      const id = seedBet(h, {
        band: 3,
        status: verdict === "win" ? "settled" : "cashed_out",
        settleOffsetMs: -MINUTE,
      });
      if (verdict === "win") {
        h.db
          .prepare(
            `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, final)
             VALUES (?, 'tap', 0.5, 'win', 15, ?, 1)`,
          )
          .run(id, h.clock.current);
      } else {
        h.db
          .prepare(
            "INSERT INTO cash_outs (bet_id, points, cashed_out_at, alert_showing) VALUES (?, -10, ?, 0)",
          )
          .run(id, h.clock.current);
      }
      return id;
    };
    seedSettled("win");
    seedSettled("win");
    seedSettled("cash_out"); // lower id than the third win: the streak restarts, then one win
    seedSettled("win");
    expect(betResults(h).map((result) => result.kind)).toEqual(["win", "win", "cash_out", "win"]);
    expect(unlockedIds(await score(h))).not.toContain("sky_freeloader");
  });

  it("the export has no achievements key until one is unlocked, then lists them", async () => {
    const h = await setup();
    expect(Object.keys(buildExport(h.db, h.clock.now()))).not.toContain("achievements");
    await settle(h, 1, "moist");
    expect(buildExport(h.db, h.clock.now())["achievements"]).toEqual([
      expect.objectContaining({ id: "cloud_whisperer" }),
      expect.objectContaining({ id: "first_nap" }),
    ]);
  });

  it("the response parses with the web schema, achievements in the spec's order", async () => {
    const h = await setup();
    const parsed = scoreSchema.parse(await score(h));
    expect(parsed.achievements?.map((item) => item.name)).toEqual([
      "First nap",
      "Cloud whisperer",
      "Sky freeloader",
      "Knows when to fold",
    ]);
  });

  it("AC-029.2: with the ranks flag off the score has no rank, no achievements and writes no row", async () => {
    const h = await setup({ ranks: false });
    await settle(h, 3, "moist");
    const body = await score(h);
    expect(Object.keys(body)).not.toContain("rank");
    expect(Object.keys(body)).not.toContain("achievements");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM achievements").get()).toEqual({ n: 0 });
    expect(scoreSchema.parse(body).rank).toBeUndefined();
  });

  it("syncing is idempotent and works on a bare database handle", async () => {
    const h = await setup();
    await settle(h, 1, "moist");
    const first = syncAchievements({ db: h.db });
    const second = syncAchievements({ db: h.db });
    expect(second).toEqual(first);
  });
});
