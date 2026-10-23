import { afterEach, describe, expect, it } from "vitest";

import { LAUNDRY_PLAN } from "../src/domain/chores.js";
import { parseSnapshot } from "../src/domain/savings.js";
import { loadSavings } from "../src/server/savings.js";
import { savingsEstimate, savingsSnapshotText } from "../src/server/ledger/savings.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { EXAMPLE_HOUSEHOLD, createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";

interface Estimate {
  time_min?: number;
  water_l: number;
  electricity_kwh: number;
  assumption: string;
  basis: string;
}
interface CardJson {
  id: number;
  chore_type: string;
  quote: { id: number } | null;
  savings_estimate?: Estimate;
}

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<CoreHarness> {
  harness = await createCoreHarness({ weatherProfile: FAKE_WEATHER_PROFILES.breezy, ...options });
  await pair(harness);
  // Inside the line-dry offer window (10:00 Madrid).
  harness.clock.current = Date.UTC(2026, 9, 22, 8, 0);
  return harness;
}

const quick = async (h: CoreHarness, choreType: string): Promise<CardJson> =>
  (await h.post("/api/cards/quick", { chore_type: choreType })).json<CardJson>();

const todayCards = async (h: CoreHarness): Promise<CardJson[]> =>
  (await h.get("/api/today")).json<{ cards: CardJson[] }>().cards;

/** Places a do-nothing bet from the card's quote and reads the snapshot the bet stored. */
async function snapshotOfBet(h: CoreHarness, card: CardJson) {
  const bet = await h.post("/api/bets", {
    card_id: card.id,
    quote_id: card.quote!.id,
    kind: "do_nothing",
  });
  expect(bet.statusCode).toBe(201);
  const row = h.db
    .prepare<[number], { savings_snapshot: string }>(
      "SELECT savings_snapshot FROM bets WHERE id = ?",
    )
    .get(bet.json<{ id: number }>().id)!;
  return parseSnapshot(row.savings_snapshot)!;
}

describe("AC-011.7: a card that offers a do-nothing bet shows what a win would save", () => {
  it.each(["plants", "laundry_line"])(
    "AC-011.7: the %s estimate on Today equals the snapshot a bet placed from that quote stores",
    async (choreType) => {
      const h = await setup();
      const card = await quick(h, choreType);
      const shown = (await todayCards(h)).find((candidate) => candidate.id === card.id)!;
      expect(shown.savings_estimate).toBeDefined();
      const snapshot = await snapshotOfBet(h, shown);
      expect(shown.savings_estimate).toEqual({
        ...(snapshot.time_min > 0 ? { time_min: snapshot.time_min } : {}),
        water_l: snapshot.water_l,
        electricity_kwh: snapshot.electricity_kwh,
        assumption: snapshot.assumption,
        basis: snapshot.basis,
      });
    },
  );

  it("AC-011.7: the same estimate is on the card the quick chip and the card route return", async () => {
    const h = await setup();
    const created = await quick(h, "plants");
    const fetched = (await h.get(`/api/cards/${created.id}`)).json<CardJson>();
    const listed = (await todayCards(h)).find((card) => card.id === created.id)!;
    expect(created.savings_estimate).toBeDefined();
    expect(fetched.savings_estimate).toEqual(created.savings_estimate);
    expect(listed.savings_estimate).toEqual(created.savings_estimate);
  });

  it("AC-011.4, AC-011.7: line-drying saves the dryer's electricity and no minutes, so time is left out", async () => {
    const h = await setup();
    const card = await quick(h, "laundry_line");
    const estimate = (await todayCards(h)).find((c) => c.id === card.id)!.savings_estimate!;
    expect(estimate).not.toHaveProperty("time_min");
    expect(estimate.electricity_kwh).toBeGreaterThan(0);
    expect(estimate.assumption).toContain("heat-pump");
  });

  it("AC-011.7: plants save minutes and litres, with the assumption and where it comes from", async () => {
    const h = await setup();
    const card = await quick(h, "plants");
    const estimate = (await todayCards(h)).find((c) => c.id === card.id)!.savings_estimate!;
    expect(estimate.time_min).toBeGreaterThan(0);
    expect(estimate.water_l).toBeGreaterThan(0);
    expect(estimate.assumption.length).toBeGreaterThan(0);
    expect(estimate.basis).toMatch(/sourced|typical estimate|household baseline/);
  });

  it("AC-011.7: follows the household baseline of the moment, while a placed bet keeps its own snapshot", async () => {
    const h = await setup({ flags: { onboarding: true } });
    const card = await quick(h, "laundry_line");
    const before = (await todayCards(h)).find((c) => c.id === card.id)!.savings_estimate!;
    const placed = await snapshotOfBet(h, card);
    expect(before.assumption).toBe(placed.assumption);
    // The household changes its dryer: a new card's estimate follows, the placed bet's does not.
    const answers = {
      outdoorItems: [],
      dryer: "vented",
      airConditioning: false,
      heaterThisSeason: false,
      location: { latitude: 41.4, longitude: 2.16 },
    };
    const put = await h.request({
      method: "PUT",
      url: "/api/onboarding",
      payload: answers,
      headers: { cookie: h.cookie, origin: "http://localhost:8787" },
    });
    expect(put.statusCode).toBe(200);
    const next = await quick(h, "laundry_line");
    const after = (await todayCards(h)).find((c) => c.id === next.id)!.savings_estimate!;
    expect(after.assumption).toContain("vented");
    expect(after.assumption).not.toBe(before.assumption);
    const stored = h.db
      .prepare<[], { savings_snapshot: string }>("SELECT savings_snapshot FROM bets LIMIT 1")
      .get()!;
    expect(parseSnapshot(stored.savings_snapshot)!.assumption).toBe(before.assumption);
  });

  it("AC-011.7: nothing is added to any total, and a card without a bet to offer has no estimate", async () => {
    const h = await setup({ weatherProfile: FAKE_WEATHER_PROFILES.heatwave });
    const before = (await h.get("/api/today")).json<{ week: { totals: object } }>().week.totals;
    const alert = await quick(h, "plants");
    const cards = await todayCards(h);
    expect(cards.find((card) => card.id === alert.id)).not.toHaveProperty("savings_estimate");
    expect((await h.get("/api/today")).json<{ week: { totals: object } }>().week.totals).toEqual(
      before,
    );
  });

  it("AC-011.7: a card that is a plain notice (coming later) has none either", async () => {
    const h = await setup();
    h.clock.current = Date.UTC(2026, 9, 22, 21, 0); // 23:00 Madrid: outside the line-dry window
    const later = await quick(h, "laundry_line");
    expect(later.quote).toBeNull();
    expect(later).not.toHaveProperty("savings_estimate");
  });

  it("AC-011.7: is computed by the function that writes the snapshot, planner chore included", async () => {
    const h = await setup();
    const deps = { db: h.db, household: EXAMPLE_HOUSEHOLD, savings: loadSavings() };
    for (const choreType of ["plants", "laundry_line", LAUNDRY_PLAN]) {
      const snapshot = parseSnapshot(savingsSnapshotText(deps, choreType))!;
      const estimate = savingsEstimate(deps, choreType)!;
      expect(estimate.water_l).toBe(snapshot.water_l);
      expect(estimate.electricity_kwh).toBe(snapshot.electricity_kwh);
      expect(estimate.assumption).toBe(snapshot.assumption);
      expect(estimate.time_min ?? 0).toBe(snapshot.time_min);
    }
    expect(savingsEstimate(deps, "not_a_chore")).toBeNull();
  });
});
