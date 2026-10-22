import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { APP_SECONDS_PER_BET, parseSnapshot, totalSavings } from "../src/domain/savings.js";
import { madridWeekOf } from "../src/domain/week.js";
import { backfillSavingsSnapshots, savingsTotals } from "../src/server/ledger/savings.js";
import { loadSavings } from "../src/server/savings.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { EXAMPLE_HOUSEHOLD, createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { HOUR, MINUTE, seedBet, settlementCount, tap } from "./support/settle.js";

let harness: CoreHarness;
let opened = false;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  if (opened) {
    await harness.close();
    opened = false;
  }
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<void> {
  harness = await createCoreHarness(options);
  opened = true;
  await pair(harness);
}

interface TodayWeek {
  week: {
    from: string;
    to: string;
    totals: {
      bets: number;
      wins: number;
      time_saved_s: number;
      app_time_s: number;
      net_time_s: number;
      water_l: number;
      electricity_kwh: number;
      assumptions: { chore_type: string; assumption: string; basis: string; wins: number }[];
    };
  };
}

const weekOfToday = async (): Promise<TodayWeek["week"]> =>
  (await harness.get("/api/today")).json<TodayWeek>().week;

describe("savings catalogue (REQ-011)", () => {
  it("every chore has a figure with an assumption; figures without a source say 'typical estimate'", () => {
    const catalogue = loadSavings();
    const figures = [
      catalogue.plants,
      catalogue.laundry_tonight,
      catalogue.ac,
      catalogue.heater,
      ...Object.values(catalogue.laundry_line),
    ];
    for (const figure of figures) {
      expect(figure.assumption.length).toBeGreaterThan(10);
      expect(["sourced", "typical estimate", "household baseline"]).toContain(figure.basis);
      expect(figure.basis === "sourced").toBe(figure.source !== undefined);
    }
    expect(catalogue.plants.basis).toBe("typical estimate");
  });

  it("AC-011.4: line-dry saves electricity only, 0 minutes, whatever the dryer", () => {
    const { laundry_line } = loadSavings();
    for (const figure of Object.values(laundry_line)) {
      expect(figure.time_min).toBe(0);
    }
    expect(laundry_line["heat-pump"].electricity_kwh).toBe(2.2);
    expect(laundry_line.vented.electricity_kwh).toBe(5.3);
    expect(laundry_line.none.electricity_kwh).toBe(0);
  });
});

describe("the snapshot on the bet (design.md, Points and savings)", () => {
  it("AC-011.1: is written in the bet INSERT from the catalogue and the household baseline, and never changes", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.mild });
    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
      quote: { id: number };
    }>();
    const bet = (
      await harness.post("/api/bets", {
        card_id: card.id,
        quote_id: card.quote.id,
        kind: "do_nothing",
      })
    ).json<{ id: number }>();
    const text = harness.db
      .prepare<[number], { savings_snapshot: string }>(
        "SELECT savings_snapshot FROM bets WHERE id = ?",
      )
      .get(bet.id)!.savings_snapshot;
    expect(parseSnapshot(text)).toMatchObject({
      version: 1,
      chore_type: "plants",
      time_min: 5,
      water_l: 4,
      electricity_kwh: 0,
      basis: "typical estimate",
    });
    expect(() =>
      harness.db.prepare("UPDATE bets SET savings_snapshot = '{}' WHERE id = ?").run(bet.id),
    ).toThrow(/cannot be updated/);
  });

  it("AC-011.1: line-dry uses the household's dryer", async () => {
    await setup({
      weatherProfile: FAKE_WEATHER_PROFILES.breezy,
      household: { ...EXAMPLE_HOUSEHOLD, dryer: "vented" },
    });
    harness.clock.current = Date.UTC(2026, 9, 22, 8, 0); // 10:00 Madrid, inside the offer window
    const card = (await harness.post("/api/cards/quick", { chore_type: "laundry_line" })).json<{
      id: number;
      quote: { id: number };
    }>();
    const bet = (
      await harness.post("/api/bets", {
        card_id: card.id,
        quote_id: card.quote.id,
        kind: "do_nothing",
      })
    ).json<{ id: number }>();
    const text = harness.db
      .prepare<[number], { savings_snapshot: string }>(
        "SELECT savings_snapshot FROM bets WHERE id = ?",
      )
      .get(bet.id)!.savings_snapshot;
    expect(parseSnapshot(text)).toMatchObject({
      chore_type: "laundry_line",
      time_min: 0,
      electricity_kwh: 5.3,
      assumption: expect.stringContaining("vented dryer") as unknown,
    });
  });

  it("AC-011.1: a backfill gives a bet with a NULL snapshot its figure once, then leaves it alone", async () => {
    await setup();
    const betId = seedBet(harness, { withSnapshot: false });
    const deps = { db: harness.db, household: EXAMPLE_HOUSEHOLD, savings: loadSavings() };
    expect(backfillSavingsSnapshots(deps)).toBe(1);
    const filled = harness.db
      .prepare<[number], { savings_snapshot: string }>(
        "SELECT savings_snapshot FROM bets WHERE id = ?",
      )
      .get(betId)!.savings_snapshot;
    expect(parseSnapshot(filled)).toMatchObject({ chore_type: "plants", water_l: 4 });
    expect(backfillSavingsSnapshots(deps)).toBe(0);
    expect(
      harness.db
        .prepare<[number], { savings_snapshot: string }>(
          "SELECT savings_snapshot FROM bets WHERE id = ?",
        )
        .get(betId)!.savings_snapshot,
    ).toBe(filled);
  });

  it("AC-011.1: starting the app on a database with bets that have no snapshot backfills them, and a win then counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sib-backfill-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const dbPath = join(dir, "sib.db");
    harness = await createCoreHarness({ dbPath });
    opened = true;
    const betId = seedBet(harness, { withSnapshot: false });
    await harness.close();

    harness = await createCoreHarness({ dbPath });
    await pair(harness);
    expect(
      harness.db.prepare("SELECT savings_snapshot IS NOT NULL AS filled FROM bets").get(),
    ).toEqual({ filled: 1 });
    expect((await tap(harness, betId, "moist")).status).toBe(200);
    expect(savingsTotals(harness)).toMatchObject({ wins: 1, water_l: 4 });
  });
});

describe("totals (REQ-011)", () => {
  it("AC-011.1, AC-011.2: only won bets add savings; losses, do-it decisions and undone bets add none", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const win = seedBet(harness);
    const loss = seedBet(harness);
    const doIt = seedBet(harness, { kind: "do_it" });
    await tap(harness, win, "moist");
    await tap(harness, loss, "dry");
    await harness.core.scheduler.tickSettlement();
    seedBet(harness, { status: "undone" });
    expect(settlementCount(harness)).toBe(3);

    const totals = savingsTotals(harness);
    expect(totals).toMatchObject({ wins: 1, water_l: 4, electricity_kwh: 0, time_saved_s: 300 });
    expect(doIt).toBeGreaterThan(0);
  });

  it("AC-011.3: net time is time saved minus 30 s per bet or do-it decision not undone, both parts shown", async () => {
    await setup();
    const wins = [seedBet(harness), seedBet(harness)];
    for (const betId of wins) {
      await tap(harness, betId, "moist");
    }
    seedBet(harness, { kind: "do_it", status: "open", settleOffsetMs: HOUR });
    seedBet(harness, { status: "undone" });
    const totals = savingsTotals(harness);
    expect(totals.bets).toBe(3);
    expect(totals.time_saved_s).toBe(600);
    expect(totals.app_time_s).toBe(3 * APP_SECONDS_PER_BET);
    expect(totals.net_time_s).toBe(600 - 90);
  });

  it("AC-011.3: net time can be negative when the app time exceeds the time saved", () => {
    const totals = totalSavings([], 4);
    expect(totals).toMatchObject({ time_saved_s: 0, app_time_s: 120, net_time_s: -120 });
  });

  it("AC-011.4: a won line-dry bet adds electricity and 0 minutes", async () => {
    await setup();
    const betId = seedBet(harness, { chore: "laundry_line" });
    await tap(harness, betId, "line_dry");
    expect(savingsTotals(harness)).toMatchObject({
      wins: 1,
      time_saved_s: 0,
      electricity_kwh: 2.2,
      water_l: 0,
    });
  });

  it("AC-011.5: every figure comes with its assumption", async () => {
    await setup();
    await tap(harness, seedBet(harness), "moist");
    await tap(harness, seedBet(harness, { chore: "laundry_line" }), "line_dry");
    const totals = (await weekOfToday()).totals;
    expect(totals.assumptions.map((item) => item.chore_type).sort()).toEqual([
      "laundry_line",
      "plants",
    ]);
    expect(totals.assumptions.find((item) => item.chore_type === "laundry_line")).toMatchObject({
      assumption: "vs a heat-pump dryer, ~2.2 kWh per load; no minutes saved",
      basis: "sourced",
    });
  });

  it("AC-011.6: Today shows this week's totals, Monday to Sunday in Madrid time", async () => {
    await setup();
    // Sunday 25 Oct 2026, 23:30 Madrid (UTC+1 after the clock change at 03:00): still the week of 19 Oct.
    harness.clock.current = Date.UTC(2026, 9, 25, 22, 30);
    const sundayWin = seedBet(harness, { settleOffsetMs: -10 * MINUTE });
    await tap(harness, sundayWin, "moist");
    expect(await weekOfToday()).toMatchObject({
      from: "2026-10-19",
      to: "2026-10-25",
      totals: { wins: 1, water_l: 4, bets: 1 },
    });

    // 40 minutes later it is Monday 26 Oct 00:10 Madrid: a new week that starts empty.
    harness.clock.advance(40 * MINUTE);
    expect(await weekOfToday()).toMatchObject({
      from: "2026-10-26",
      to: "2026-11-01",
      totals: { wins: 0, water_l: 0, bets: 0, time_saved_s: 0, net_time_s: 0 },
    });
    const mondayWin = seedBet(harness);
    await tap(harness, mondayWin, "moist");
    expect((await weekOfToday()).totals).toMatchObject({ wins: 1, water_l: 4, bets: 1 });
    // All-time totals (Score) still have both.
    expect(savingsTotals(harness)).toMatchObject({ wins: 2, water_l: 8 });
  });
});

describe("Madrid week (AC-011.6)", () => {
  it("runs Monday 00:00 to the next Monday 00:00 Madrid time, also across the October clock change", () => {
    const week = madridWeekOf(Date.UTC(2026, 9, 22, 12, 0)); // Thursday 22 Oct
    expect(week).toMatchObject({ fromDate: "2026-10-19", toDate: "2026-10-25" });
    // CEST (UTC+2) at the start, CET (UTC+1) at the end: the week is 169 hours long.
    expect(week.fromMs).toBe(Date.UTC(2026, 9, 18, 22, 0));
    expect(week.toMs).toBe(Date.UTC(2026, 9, 25, 23, 0));
    expect((week.toMs - week.fromMs) / HOUR).toBe(169);
  });

  it("puts Sunday in the week that started the Monday before, and Monday in a new one", () => {
    expect(madridWeekOf(Date.UTC(2026, 9, 25, 22, 59)).fromDate).toBe("2026-10-19");
    expect(madridWeekOf(Date.UTC(2026, 9, 25, 23, 0)).fromDate).toBe("2026-10-26");
    expect(madridWeekOf(Date.UTC(2026, 9, 18, 21, 59)).fromDate).toBe("2026-10-12");
  });
});
