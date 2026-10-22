import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bandDroppedEnough } from "../src/domain/rescue.js";
import { remainingWindow, RESCUE_CHECK_INTERVAL_MS } from "../src/server/ledger/rescue.js";
import type { BetRow } from "../src/server/ledger/rows.js";
import { createScheduler } from "../src/server/scheduler.js";
import { slipsSchema } from "../src/web/api.js";
import { FAKE_WEATHER_PROFILES, type FakeWeatherProfile } from "../src/server/weather/fake.js";
import { madridWallTime } from "../src/domain/time.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { HOUR, MINUTE, seedBet } from "./support/settle.js";

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Rain that is there, but little: the plants rule says "toss-up" (band 2). */
const DRIZZLE: FakeWeatherProfile = {
  temperatureC: 19,
  dryProbabilityPct: 20,
  rain: { startsAfterHours: 2, hours: 1, mmPerHour: 0.6 },
};

async function setup(
  flags: { rescue?: boolean; score?: boolean } = { rescue: true },
  weatherProfile: FakeWeatherProfile = FAKE_WEATHER_PROFILES.rainy,
): Promise<CoreHarness> {
  harness = await createCoreHarness({ flags, weatherProfile });
  await pair(harness);
  return harness;
}

interface RescueJson {
  can_cash_out: boolean;
  cash_out_points: number;
  checked_at: string | null;
  alert: { text: string; rule_band: number; rule_band_name: string } | null;
}
interface SlipBet {
  id: number;
  kind: string;
  status: string;
  band: number;
  odds: number;
  rescue?: RescueJson;
  result?: { verdict: string; points: number; evidence: string; settled_at: string };
  receipt?: Record<string, unknown>;
}
interface Slips {
  settle_now: SlipBet[];
  waiting: SlipBet[];
  settled: SlipBet[];
}

async function slips(): Promise<Slips> {
  const response = await harness!.get("/api/slips");
  expect(response.statusCode).toBe(200);
  return response.json<Slips>();
}

async function placeBet(kind: "do_nothing" | "do_it" = "do_nothing"): Promise<SlipBet> {
  const h = harness!;
  const card = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<{ id: number }>();
  const quote = (await h.get(`/api/cards/${card.id}`)).json<{ quote: { id: number } }>().quote;
  const response = await h.post("/api/bets", { card_id: card.id, quote_id: quote.id, kind });
  expect(response.statusCode).toBe(201);
  return response.json<SlipBet>();
}

async function waitingBet(id: number): Promise<SlipBet> {
  const bet = (await slips()).waiting.find((candidate) => candidate.id === id);
  expect(bet).toBeDefined();
  return bet!;
}

async function pointsTotal(): Promise<number> {
  const today = (await harness!.get("/api/today")).json<{ points: { total: number } }>();
  return today.points.total;
}

describe("REQ-022: rescue alerts (AC-022.1)", () => {
  it("AC-022.1: the band-drop rule needs two bands, never fires on a rise or a one-band fall", () => {
    expect(bandDroppedEnough(3, 1)).toBe(true);
    expect(bandDroppedEnough(4, 0)).toBe(true);
    expect(bandDroppedEnough(3, 2)).toBe(false);
    expect(bandDroppedEnough(2, 2)).toBe(false);
    expect(bandDroppedEnough(1, 3)).toBe(false);
    expect(bandDroppedEnough(0, 0)).toBe(false);
  });

  it("AC-022.1: raises the alert on the slip when the rule band of the remaining window falls two bands below the bet's", async () => {
    const h = await setup();
    const bet = await placeBet();
    expect(bet.band).toBe(3); // the rainy forecast: 3 mm, "likely"
    expect((await waitingBet(bet.id)).rescue).toMatchObject({
      can_cash_out: true,
      cash_out_points: -10,
      checked_at: null,
      alert: null,
    });

    // The first check sees the same forecast: no alert, but it is on record.
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    expect((await waitingBet(bet.id)).rescue).toMatchObject({ alert: null });
    expect((await waitingBet(bet.id)).rescue?.checked_at).toBe(
      new Date(h.clock.now()).toISOString(),
    );

    // The rain goes away: dry and mild is "unlikely" (band 1), two bands below the bet's 3.
    h.weather.setProfile(FAKE_WEATHER_PROFILES.mild);
    h.clock.advance(RESCUE_CHECK_INTERVAL_MS);
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    const alert = (await waitingBet(bet.id)).rescue?.alert;
    expect(alert).toMatchObject({ rule_band: 1, rule_band_name: "unlikely" });
    expect(alert?.text).toContain("turned against this bet");
    expect(alert?.text).toContain("unlikely (35%)");
    expect(alert?.text).toContain("likely (70%)");
  });

  it("AC-022.1: a fall of one band raises no alert", async () => {
    const h = await setup();
    const bet = await placeBet(); // band 3
    h.weather.setProfile(DRIZZLE); // 0.6 mm: band 2
    await h.core.scheduler.tickRescue();
    expect((await waitingBet(bet.id)).rescue).toMatchObject({ alert: null });
    const check = h.db.prepare("SELECT rule_band, alert FROM rescue_checks").get();
    expect(check).toEqual({ rule_band: 2, alert: 0 });
  });

  it("AC-022.1: re-checks the forecast at least every hour, not on every tick", async () => {
    const h = await setup();
    await placeBet();
    const fetches = (): number => h.weather.requests.length;
    const base = fetches();
    await h.core.scheduler.tickRescue();
    expect(fetches()).toBe(base + 1);

    // The 60 s scheduler ticks inside the half hour do not fetch again.
    for (let minute = 1; minute < 30; minute += 1) {
      h.clock.advance(MINUTE);
      await h.core.scheduler.tickRescue();
    }
    expect(fetches()).toBe(base + 1);

    // Half an hour after the check it is due, so the gap never reaches an hour.
    h.clock.advance(MINUTE);
    await h.core.scheduler.tickRescue();
    expect(fetches()).toBe(base + 2);
    h.clock.advance(RESCUE_CHECK_INTERVAL_MS);
    await h.core.scheduler.tickRescue();
    expect(fetches()).toBe(base + 3);
    expect(RESCUE_CHECK_INTERVAL_MS).toBeLessThanOrEqual(HOUR);
  });

  it("AC-022.1: the alert goes away when the next check sees the forecast recover", async () => {
    const h = await setup();
    const bet = await placeBet();
    h.weather.setProfile(FAKE_WEATHER_PROFILES.mild);
    await h.core.scheduler.tickRescue();
    expect((await waitingBet(bet.id)).rescue?.alert).not.toBeNull();

    h.weather.setProfile(FAKE_WEATHER_PROFILES.rainy);
    h.clock.advance(RESCUE_CHECK_INTERVAL_MS);
    await h.core.scheduler.tickRescue();
    expect((await waitingBet(bet.id)).rescue?.alert).toBeNull();
  });

  it("AC-022.1: keeps the last check when the forecast cannot be fetched, and tries again at the next tick", async () => {
    const h = await setup();
    const bet = await placeBet();
    h.weather.setProfile(FAKE_WEATHER_PROFILES.mild);
    await h.core.scheduler.tickRescue();
    const before = (await waitingBet(bet.id)).rescue;

    h.weather.failWith = new Error("offline");
    h.clock.advance(RESCUE_CHECK_INTERVAL_MS);
    expect(await h.core.scheduler.tickRescue()).toBe(0);
    expect((await waitingBet(bet.id)).rescue).toEqual(before);

    h.weather.failWith = undefined;
    h.weather.setProfile(FAKE_WEATHER_PROFILES.rainy);
    h.clock.advance(MINUTE);
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    expect((await waitingBet(bet.id)).rescue?.alert).toBeNull();
  });

  it("AC-022.1 + safety: a heat, frost or storm limit in the remaining window raises the alert even without a band drop", async () => {
    const h = await setup({ rescue: true }, FAKE_WEATHER_PROFILES.hot);
    const bet = await placeBet();
    expect(bet.band).toBe(0); // hot and dry: nothing lower to fall to
    h.weather.setProfile(FAKE_WEATHER_PROFILES.storm);
    await h.core.scheduler.tickRescue();
    const alert = (await waitingBet(bet.id)).rescue?.alert;
    expect(alert?.text).toContain("Safety: Storm");
    expect(alert?.text).not.toContain("turned against this bet");
  });

  it("AC-022.1: only open bets on doing nothing are checked; a do-it decision has no rescue", async () => {
    const h = await setup();
    const doIt = await placeBet("do_it");
    expect(await h.core.scheduler.tickRescue()).toBe(0);
    expect((await waitingBet(doIt.id)).rescue).toBeUndefined();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rescue_checks").get()).toEqual({ n: 0 });
  });

  it("AC-022.1: no check once the settle time has come", async () => {
    const h = await setup();
    const bet = await placeBet();
    const settleAt = (
      h.db.prepare("SELECT settle_at FROM bets WHERE id = ?").get(bet.id) as { settle_at: number }
    ).settle_at;
    h.clock.current = settleAt;
    expect(await h.core.scheduler.tickRescue()).toBe(0);
    h.core.scheduler.tick();
    const due = (await slips()).settle_now.find((candidate) => candidate.id === bet.id);
    expect(due?.rescue).toBeUndefined();
  });

  it("AC-022.1: the scheduler runs the rescue step on its 60 s loop, once at a time", async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      let calls = 0;
      let release: () => void = () => undefined;
      const scheduler = createScheduler({ db: h.db, now: h.clock.now }, () => undefined, {
        rescue: () => {
          calls += 1;
          return new Promise<number>((resolve) => {
            release = () => {
              resolve(0);
            };
          });
        },
      });
      scheduler.start();
      expect(calls).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(calls).toBe(1); // the pass is still running: no second one stacks up
      release();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /** Holds the next forecast request until `release()`, so a test can change bets meanwhile. */
  function holdForecast(h: CoreHarness): { release: () => void } {
    const original = h.weather.getForecast.bind(h.weather);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.weather.getForecast = async (request) => {
      await gate;
      return original(request);
    };
    return { release };
  }

  it("AC-022.1: a bet cashed out while the forecast is on its way gets no rescue check, and the others do", async () => {
    const h = await setup();
    const folded = await placeBet();
    const kept = await placeBet();
    const held = holdForecast(h);
    const pass = h.core.scheduler.tickRescue();
    await Promise.resolve();
    expect((await h.post(`/api/bets/${folded.id}/cashout`, {})).statusCode).toBe(200);
    held.release();
    expect(await pass).toBe(1);
    expect(h.db.prepare("SELECT bet_id FROM rescue_checks").all()).toEqual([{ bet_id: kept.id }]);
  });

  it("AC-022.1: a bet undone or deleted while the forecast is on its way does not abort the pass", async () => {
    const h = await setup();
    const undone = await placeBet();
    const deleted = await placeBet();
    const kept = await placeBet();
    const held = holdForecast(h);
    const pass = h.core.scheduler.tickRescue();
    await Promise.resolve();
    expect((await h.delete(`/api/bets/${undone.id}`)).statusCode).toBe(200);
    expect((await h.delete(`/api/bets/${deleted.id}/data`)).statusCode).toBeLessThan(300);
    held.release();
    expect(await pass).toBe(1);
    expect(h.db.prepare("SELECT bet_id FROM rescue_checks").all()).toEqual([{ bet_id: kept.id }]);
  });

  it("AC-022.1: a bet whose settle time passes while the forecast is on its way is not checked", async () => {
    const h = await setup();
    const bet = await placeBet();
    const settleAt = (
      h.db.prepare("SELECT settle_at FROM bets WHERE id = ?").get(bet.id) as { settle_at: number }
    ).settle_at;
    h.clock.current = settleAt - 1;
    const held = holdForecast(h);
    const pass = h.core.scheduler.tickRescue();
    await Promise.resolve();
    h.clock.current = settleAt;
    held.release();
    expect(await pass).toBe(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rescue_checks").get()).toEqual({ n: 0 });
  });

  it("AC-022.1 + safety: the backstop alert is not hidden when the forecast does not cover the window", async () => {
    const h = await setup({ rescue: true }, FAKE_WEATHER_PROFILES.mild);
    // A plants bet that settles 100 h ahead: the 96 h forecast cannot price its window.
    const id = seedBet(h, { status: "open", settleOffsetMs: 100 * HOUR, openHours: 101 });
    h.weather.setProfile(FAKE_WEATHER_PROFILES.mild);
    expect(await h.core.scheduler.tickRescue()).toBe(0); // no rule band, no limit crossed: nothing to say
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rescue_checks").get()).toEqual({ n: 0 });

    h.weather.setProfile(FAKE_WEATHER_PROFILES.storm);
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    expect(h.db.prepare("SELECT rule_band, alert FROM rescue_checks").get()).toEqual({
      rule_band: null,
      alert: 1,
    });
    const bet = (await slips()).waiting.find((candidate) => candidate.id === id);
    expect(bet?.rescue?.alert).toMatchObject({ rule_band: null, rule_band_name: null });
    expect(bet?.rescue?.alert?.text).toContain("Safety: Storm");
    slipsSchema.parse((await h.get("/api/slips")).json());
  });

  describe("the remaining window", () => {
    const placedAt = Date.UTC(2026, 9, 22, 8, 0); // 10:00 Madrid
    const bet = (settleAt: number): BetRow =>
      ({ placed_at: placedAt, settle_at: settleAt }) as BetRow;
    const nextMorning = madridWallTime(placedAt, 1, 8);

    it("plants: from now to the bet's settle time", () => {
      const now = placedAt + 5 * HOUR;
      expect(
        remainingWindow(bet(nextMorning), { chore_type: "plants", sunset_at: null }, now),
      ).toEqual({
        fromMs: now,
        toMs: nextMorning,
      });
    });

    it("is empty once the window is over", () => {
      expect(
        remainingWindow(bet(nextMorning), { chore_type: "plants", sunset_at: null }, nextMorning),
      ).toBeNull();
    });

    it("a fixed window that has not begun yet is looked at whole (the AC's night)", () => {
      const window = remainingWindow(
        bet(madridWallTime(placedAt, 1, 7)),
        { chore_type: "ac", sunset_at: null },
        placedAt,
      );
      expect(window).toEqual({
        fromMs: madridWallTime(placedAt, 0, 22),
        toMs: madridWallTime(placedAt, 1, 7),
      });
    });

    it("laundry tonight starts at the sunset stored on its card", () => {
      const sunset = Date.UTC(2026, 9, 22, 17, 30);
      const window = remainingWindow(
        bet(madridWallTime(placedAt, 1, 8)),
        { chore_type: "laundry_tonight", sunset_at: sunset },
        placedAt,
      );
      expect(window?.fromMs).toBe(sunset);
    });

    it("a chore that is not one of this version's has no window", () => {
      expect(
        remainingWindow(
          bet(nextMorning),
          { chore_type: "other_weather", sunset_at: null },
          placedAt,
        ),
      ).toBeNull();
    });
  });

  it("AC-022.1: line-drying is checked over what is left of its 18:00 window", async () => {
    const h = await setup();
    // Placed at 10:00 Madrid; line-dry settles at 18:00 (16:00 UTC) the same day.
    const id = seedBet(h, {
      chore: "laundry_line",
      band: 4,
      status: "open",
      settleOffsetMs: 8 * HOUR,
      openHours: 8, // placed at the clock's 10:00 Madrid
    });
    h.weather.setProfile({
      ...FAKE_WEATHER_PROFILES.breezy,
      rain: { startsAfterHours: 0, hours: 3, mmPerHour: 1 },
    });
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    const row = h.db.prepare("SELECT rule_band, alert FROM rescue_checks WHERE bet_id = ?").get(id);
    expect(row).toEqual({ rule_band: 0, alert: 1 }); // a wet hour: band 0, four bands below
  });
});

describe("REQ-022 and a Skip today bet from the laundry planner (REQ-021)", () => {
  it("AC-022.1: a Skip today bet is checked over the drying hours of the day it chose, with the line-dry rule", async () => {
    const h = await setup({ rescue: true }, FAKE_WEATHER_PROFILES.breezy);
    // Skip today for today: placed now (10:00 Madrid), settles 18:00 Madrid (16:00Z).
    const id = seedBet(h, {
      chore: "laundry_plan",
      band: 4,
      status: "open",
      settleOffsetMs: 8 * HOUR,
      openHours: 8,
    });
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    expect(h.db.prepare("SELECT rule_band, alert FROM rescue_checks").get()).toEqual({
      rule_band: 4,
      alert: 0,
    });

    h.weather.setProfile({
      ...FAKE_WEATHER_PROFILES.breezy,
      rain: { startsAfterHours: 1, hours: 2, mmPerHour: 1 },
    });
    h.clock.advance(RESCUE_CHECK_INTERVAL_MS);
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    expect(h.db.prepare("SELECT rule_band, alert FROM rescue_checks").get()).toEqual({
      rule_band: 0,
      alert: 1,
    });
    const bet = (await slips()).waiting.find((candidate) => candidate.id === id);
    expect(bet?.rescue).toMatchObject({ can_cash_out: true, alert: { rule_band: 0 } });
  });

  it("AC-022.1: a Skip today bet for a later day is checked over that day's window only", async () => {
    const h = await setup({ rescue: true }, FAKE_WEATHER_PROFILES.breezy);
    // Two days ahead: 18:00 Madrid on 24 Oct is 16:00Z.
    const id = seedBet(h, {
      chore: "laundry_plan",
      band: 4,
      status: "open",
      settleOffsetMs: 56 * HOUR,
      openHours: 2,
    });
    h.weather.setProfile({
      ...FAKE_WEATHER_PROFILES.breezy,
      rain: { startsAfterHours: 0, hours: 3, mmPerHour: 1 }, // rain today, before that day's window
    });
    expect(await h.core.scheduler.tickRescue()).toBe(1);
    expect(h.db.prepare("SELECT bet_id, rule_band FROM rescue_checks").get()).toEqual({
      bet_id: id,
      rule_band: 4,
    });
  });

  it("AC-022.2: cashing out a Skip today bet gives its own title on the receipt", async () => {
    const h = await setup();
    const id = seedBet(h, {
      chore: "laundry_plan",
      band: 3,
      status: "open",
      settleOffsetMs: 8 * HOUR,
      openHours: 1,
    });
    const body = (await h.post(`/api/bets/${id}/cashout`, {})).json<{
      receipt: { title: string; points: number };
    }>();
    expect(body.receipt).toMatchObject({ title: "Skip washing today", points: -10 });
    const settled = (await slips()).settled.find((bet) => bet.id === id);
    expect((settled as { title?: string } | undefined)?.title).toBe("Skip washing today");
  });
});

describe("REQ-022: the points total", () => {
  it("AC-022.2: adds final settlements, cash-outs and advice followed", async () => {
    const h = await setup();
    const won = seedBet(h, { band: 3, status: "due" });
    await h.post(`/api/bets/${won}/settle`, { answer: "moist" }); // +15
    h.db
      .prepare(
        "INSERT INTO cards (input_text, chore_type, kind, advice_points, created_at) VALUES ('plan', 'laundry_plan', 'weather', 5, 1)",
      )
      .run(); // advice followed: +5
    const folded = await placeBet();
    await h.post(`/api/bets/${folded.id}/cashout`, {}); // -10
    expect(await pointsTotal()).toBe(15 + 5 - 10);
    const { pointsTotal: ledgerTotal } = await import("../src/server/ledger/points.js");
    expect(ledgerTotal({ db: h.db })).toBe(10);
  });
});

describe("REQ-022: flag off", () => {
  it("AC-029.2: with the flag off there is no rescue step, no rescue field and no cash-out route", async () => {
    const h = await setup({});
    const bet = await placeBet();
    const base = h.weather.requests.length;
    expect(await h.core.scheduler.tickRescue()).toBe(0);
    expect(h.weather.requests.length).toBe(base);
    expect((await waitingBet(bet.id)).rescue).toBeUndefined();
    expect(Object.keys((await waitingBet(bet.id)) as object)).not.toContain("rescue");
    const cashout = await h.post(`/api/bets/${bet.id}/cashout`, {});
    expect(cashout.statusCode).toBe(404);
    expect(h.db.prepare("SELECT status FROM bets WHERE id = ?").get(bet.id)).toEqual({
      status: "open",
    });
    expect(await pointsTotal()).toBe(0);
  });
});

describe("REQ-022: cash-out (AC-022.2)", () => {
  it("AC-022.2: settles the bet at -10 points with no savings and keeps the locked odds", async () => {
    const h = await setup();
    const bet = await placeBet();
    const locked = h.db.prepare("SELECT * FROM bets WHERE id = ?").get(bet.id) as Record<
      string,
      unknown
    >;

    const response = await h.post(`/api/bets/${bet.id}/cashout`, {});
    expect(response.statusCode).toBe(200);
    const body = response.json<{ state: string; receipt: Record<string, unknown> }>();
    expect(body.state).toBe("cashed_out");
    expect(body.receipt).toMatchObject({
      bet_id: bet.id,
      outcome: "cash_out",
      verdict: "cash_out",
      verdict_title: "Cashed out",
      stamp: null,
      points: -10,
      total_points: -10,
      saved: null,
      weather: null,
      gemma_read: null,
      evidence: { kind: "none" },
      odds: bet.odds,
    });

    const after = h.db.prepare("SELECT * FROM bets WHERE id = ?").get(bet.id) as Record<
      string,
      unknown
    >;
    expect({ ...after, status: "open" }).toEqual(locked);
    expect(after["status"]).toBe("cashed_out");
    expect(h.db.prepare("SELECT points FROM cash_outs WHERE bet_id = ?").get(bet.id)).toEqual({
      points: -10,
    });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 0 });
    expect(await pointsTotal()).toBe(-10);
  });

  it("AC-022.2: no savings, and the bet still costs its 30 s of app time", async () => {
    const h = await setup();
    const bet = await placeBet();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    const today = (await h.get("/api/today")).json<{
      week: {
        totals: {
          wins: number;
          time_saved_s: number;
          water_l: number;
          app_time_s: number;
          net_time_s: number;
        };
      };
    }>();
    expect(today.week.totals).toMatchObject({
      wins: 0,
      time_saved_s: 0,
      water_l: 0,
      app_time_s: 30,
      net_time_s: -30,
    });
  });

  it("AC-022.2: -10 whatever the odds were", async () => {
    const h = await setup({ rescue: true }, FAKE_WEATHER_PROFILES.hot);
    const bet = await placeBet(); // band 0, 15%
    expect(bet.odds).toBe(15);
    const body = (await h.post(`/api/bets/${bet.id}/cashout`, {})).json<{
      receipt: { points: number };
    }>();
    expect(body.receipt.points).toBe(-10);
  });

  it("AC-022.2: Slips lists the cashed-out bet under Settled with -10, and no longer under Waiting", async () => {
    const h = await setup();
    const bet = await placeBet();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    const result = await slips();
    expect(result.waiting).toEqual([]);
    expect(result.settle_now).toEqual([]);
    expect(result.settled.map((entry) => [entry.id, entry.status])).toEqual([
      [bet.id, "cashed_out"],
    ]);
    expect(result.settled[0]?.result).toMatchObject({
      verdict: "cash_out",
      points: -10,
      evidence: "none",
    });
    expect(result.settled[0]?.receipt).toMatchObject({ outcome: "cash_out", points: -10 });
    expect(result.settled[0]?.rescue).toBeUndefined();
  });

  it("AC-022.2: the server's Slips answer, alert and cash-out included, passes the web client's schema", async () => {
    const h = await setup();
    const alerted = await placeBet();
    h.weather.setProfile(FAKE_WEATHER_PROFILES.mild);
    await h.core.scheduler.tickRescue();
    const folded = await placeBet();
    await h.post(`/api/bets/${folded.id}/cashout`, {});
    const parsed = slipsSchema.parse((await h.get("/api/slips")).json());
    expect(parsed.waiting.find((bet) => bet.id === alerted.id)?.rescue?.alert).not.toBeNull();
    expect(parsed.settled.map((bet) => bet.receipt.outcome)).toEqual(["cash_out"]);
  });

  it("AC-022.2: the receipt route answers for a cashed-out bet", async () => {
    const h = await setup();
    const bet = await placeBet();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    const receipt = (await h.get(`/api/bets/${bet.id}/receipt`)).json<{
      outcome: string;
      points: number;
    }>();
    expect(receipt).toMatchObject({ outcome: "cash_out", points: -10 });
  });

  it("AC-022.2: the total adds the cash-out to settled points", async () => {
    const h = await setup();
    const won = seedBet(h, { band: 3, status: "due" });
    await h.post(`/api/bets/${won}/settle`, { answer: "moist" });
    const afterWin = await pointsTotal();
    expect(afterWin).toBe(15);
    const bet = await placeBet();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    expect(await pointsTotal()).toBe(afterWin - 10);
  });

  it("AC-022.2: cashes out with an alert up, and records that the alert was showing", async () => {
    const h = await setup();
    const bet = await placeBet();
    h.weather.setProfile(FAKE_WEATHER_PROFILES.mild);
    await h.core.scheduler.tickRescue();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    expect(h.db.prepare("SELECT alert_showing FROM cash_outs").get()).toEqual({ alert_showing: 1 });
  });

  it("AC-022.2: refuses a second cash-out, an undone bet, a do-it decision and an unknown bet", async () => {
    const h = await setup();
    const bet = await placeBet();
    expect((await h.post(`/api/bets/${bet.id}/cashout`, {})).statusCode).toBe(200);
    expect((await h.post(`/api/bets/${bet.id}/cashout`, {})).statusCode).toBe(409);
    expect((await h.delete(`/api/bets/${bet.id}`)).statusCode).toBe(409); // cannot be undone any more
    expect(await pointsTotal()).toBe(-10);

    const undone = await placeBet();
    expect((await h.delete(`/api/bets/${undone.id}`)).statusCode).toBe(200);
    expect((await h.post(`/api/bets/${undone.id}/cashout`, {})).statusCode).toBe(409);

    const doIt = await placeBet("do_it");
    expect((await h.post(`/api/bets/${doIt.id}/cashout`, {})).statusCode).toBe(409);
    expect((await h.post("/api/bets/9999/cashout", {})).statusCode).toBe(404);
    expect(await pointsTotal()).toBe(-10);
  });

  it("AC-022.2: allowed up to the last millisecond before the settle time, refused from it on, when the evidence is in", async () => {
    const h = await setup();
    const early = await placeBet();
    const late = await placeBet();
    const settleAt = (
      h.db.prepare("SELECT settle_at FROM bets WHERE id = ?").get(early.id) as {
        settle_at: number;
      }
    ).settle_at;
    h.clock.current = settleAt - 1;
    expect((await h.post(`/api/bets/${early.id}/cashout`, {})).statusCode).toBe(200);

    h.clock.current = settleAt;
    expect((await h.post(`/api/bets/${late.id}/cashout`, {})).statusCode).toBe(409);
    expect((await h.post(`/api/bets/${late.id}/settle`, { answer: "moist" })).statusCode).toBe(200);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM cash_outs").get()).toEqual({ n: 1 });
  });

  it("AC-022.2: a cashed-out bet cannot be settled afterwards", async () => {
    const h = await setup();
    const bet = await placeBet();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    const settleAt = (
      h.db.prepare("SELECT settle_at FROM bets WHERE id = ?").get(bet.id) as { settle_at: number }
    ).settle_at;
    h.clock.current = settleAt + MINUTE;
    h.core.scheduler.tick();
    expect((await h.post(`/api/bets/${bet.id}/settle`, { answer: "moist" })).statusCode).toBe(409);
    expect(h.db.prepare("SELECT status FROM bets WHERE id = ?").get(bet.id)).toEqual({
      status: "cashed_out",
    });
    expect(await pointsTotal()).toBe(-10);
  });

  it("AC-022.2: a cashed-out bet is left out of calibration (Score)", async () => {
    const h = await setup({ rescue: true, score: true });
    const bet = await placeBet();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    const score = (await h.get("/api/score")).json<{
      points: { total: number };
      calibration: { settled: number };
    }>();
    expect(score.points.total).toBe(-10);
    expect(score.calibration.settled).toBe(0);
  });

  it("AC-022.2: cashing out removes the bet's rescue check and keeps whether the alert was up", async () => {
    const h = await setup();
    const bet = await placeBet();
    await h.core.scheduler.tickRescue();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rescue_checks").get()).toEqual({ n: 1 });
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rescue_checks").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT alert_showing FROM cash_outs").get()).toEqual({ alert_showing: 0 });
  });

  it("AC-015.2: deleting the bet's data removes its cash-out and rescue rows", async () => {
    const h = await setup();
    const folded = await placeBet();
    await h.post(`/api/bets/${folded.id}/cashout`, {});
    const open = await placeBet();
    await h.core.scheduler.tickRescue();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rescue_checks").get()).toEqual({ n: 1 });
    expect((await h.delete(`/api/bets/${folded.id}/data`)).statusCode).toBeLessThan(300);
    expect((await h.delete(`/api/bets/${open.id}/data`)).statusCode).toBeLessThan(300);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM cash_outs").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rescue_checks").get()).toEqual({ n: 0 });
  });
});

describe("migration 0011", () => {
  beforeEach(async () => {
    await setup();
  });

  it("keeps one rescue check and one cash-out per bet, with sane values", () => {
    const h = harness!;
    const id = seedBet(h, { status: "open", settleOffsetMs: HOUR, openHours: 1 });
    const insertCheck = h.db.prepare(
      "INSERT INTO rescue_checks (bet_id, checked_at, forecast_at, rule_band, alert) VALUES (?, 1, 1, ?, ?)",
    );
    insertCheck.run(id, 2, 0);
    expect(() => insertCheck.run(id, 2, 0)).toThrow();
    expect(() => insertCheck.run(id, 9, 0)).toThrow();
    const insertCashOut = h.db.prepare(
      "INSERT INTO cash_outs (bet_id, points, cashed_out_at, alert_showing) VALUES (?, -10, 1, 0)",
    );
    insertCashOut.run(id);
    expect(() => insertCashOut.run(id)).toThrow();
  });

  it("the status arrow open → cashed_out is the one migration 0003 already allows", () => {
    const h = harness!;
    const id = seedBet(h, { status: "open", settleOffsetMs: HOUR, openHours: 1 });
    h.db.prepare("UPDATE bets SET status = 'cashed_out' WHERE id = ?").run(id);
    expect(() => h.db.prepare("UPDATE bets SET status = 'settled' WHERE id = ?").run(id)).toThrow(
      "state machine",
    );
  });

  it("the export has no cash_outs key until something was cashed out", async () => {
    const h = harness!;
    await placeBet();
    const { buildExport } = await import("../src/server/ledger/export.js");
    expect(Object.keys(buildExport(h.db, h.clock.now()))).not.toContain("cash_outs");
  });

  it("the export carries the cash-outs", async () => {
    const h = harness!;
    const bet = await placeBet();
    await h.post(`/api/bets/${bet.id}/cashout`, {});
    const { buildExport } = await import("../src/server/ledger/export.js");
    const document = buildExport(h.db, h.clock.now());
    expect(document.cash_outs).toEqual([expect.objectContaining({ bet_id: bet.id, points: -10 })]);
    expect(document.totals.points).toBe(-10);
  });
});
