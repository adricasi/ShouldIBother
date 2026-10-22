import { afterEach, describe, expect, it } from "vitest";

import { CHORES } from "../src/domain/chores.js";
import { madridWallTime } from "../src/domain/time.js";
import { FAKE_WEATHER_PROFILES, type FakeWeatherProfile } from "../src/server/weather/fake.js";
import { slipsSchema } from "../src/web/api.js";

import {
  EXAMPLE_HOUSEHOLD,
  createCoreHarness,
  pair,
  type CoreHarness,
  type CoreHarnessOptions,
} from "./core-helpers.js";
import { T0 } from "./helpers.js";
import { judgeCalls, MINUTE, tap } from "./support/settle.js";

const USED = { ...EXAMPLE_HOUSEHOLD, airConditioning: true, heaterThisSeason: true } as const;
/** 19 °C all day: not the 20 °C row, so the 18 °C one: "likely" (band 3, 70%). */
const COOL_DAY: FakeWeatherProfile = { temperatureC: 19, dryProbabilityPct: 0 };

interface CardJson {
  id: number;
  kind: string;
  chore_type: string;
  title: string;
  notice: string | null;
  alert_reason: string | null;
  quote: null | { id: number; band: number; odds: number; source: string; settle_at: string };
}
interface BetJson {
  id: number;
  odds: number;
  settle_at: string;
}

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: CoreHarnessOptions = {}): Promise<CoreHarness> {
  harness = await createCoreHarness({
    flags: { heater: true },
    household: USED,
    weatherProfile: COOL_DAY,
    ...options,
  });
  await pair(harness);
  return harness;
}

async function heaterCard(h: CoreHarness): Promise<CardJson> {
  const response = await h.post("/api/cards/quick", { chore_type: "heater" });
  expect(response.statusCode).toBe(201);
  const card = response.json<CardJson>();
  await h.idle();
  return (await h.get(`/api/cards/${card.id}`)).json<CardJson>();
}

/** The heater card and a do-nothing bet on it, then the clock moved to just after its settle time. */
async function betAndWait(h: CoreHarness): Promise<BetJson> {
  const card = await heaterCard(h);
  expect(card.quote).not.toBeNull();
  const response = await h.post("/api/bets", {
    card_id: card.id,
    quote_id: card.quote!.id,
    kind: "do_nothing",
  });
  expect(response.statusCode).toBe(201);
  const bet = response.json<BetJson>();
  h.clock.current = Date.parse(bet.settle_at) + MINUTE;
  return bet;
}

describe("REQ-016: the heater bet (AC-016.3)", () => {
  it("AC-016.3: a heater card carries rule odds from the 08:00-22:00 day and a settle time of 21:00-23:00", async () => {
    const h = await setup();
    const card = await heaterCard(h);
    expect(card).toMatchObject({
      kind: "weather",
      chore_type: "heater",
      title: "Skip the heater",
      quote: { band: 3, odds: 70, source: "rule" },
    });
    const settleAt = Date.parse(card.quote!.settle_at);
    expect(settleAt).toBeGreaterThanOrEqual(madridWallTime(T0, 0, 21));
    expect(settleAt).toBeLessThanOrEqual(madridWallTime(T0, 0, 23));
  });

  it.each([
    [{ temperatureC: 14, dryProbabilityPct: 0 }, 1],
    [{ temperatureC: 16, dryProbabilityPct: 0 }, 2],
    [{ temperatureC: 22, dryProbabilityPct: 0 }, 4],
  ] as const)(
    "AC-016.3: the thresholds of config/rules.json price the bet (%j gives band %i)",
    async (profile, band) => {
      const h = await setup({ weatherProfile: profile });
      expect((await heaterCard(h)).quote?.band).toBe(band);
    },
  );

  it("AC-016.3: a one-tap comfort answer settles the bet: Comfortable wins, through a Gemma verdict", async () => {
    const h = await setup();
    const bet = await betAndWait(h);
    expect(CHORES.heater.tapAnswers.map((answer) => answer.id)).toEqual([
      "heater_fine",
      "heater_cold",
    ]);

    const slips = slipsSchema.parse((await h.get("/api/slips")).json());
    const due = [...slips.settle_now, ...slips.waiting].find((entry) => entry.id === bet.id);
    expect(due?.tap_answers).toEqual([
      { id: "heater_fine", label: "Comfortable without it" },
      { id: "heater_cold", label: "Too cold, I used it" },
    ]);

    const { status, body } = await tap(h, bet.id, "heater_fine");
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({
      title: "Skip the heater",
      verdict: "win",
      // (100 - 70) x 0.5 for one tap, rounded half up.
      points: 15,
      multiplier: 0.5,
      evidence: { kind: "tap" },
      saved: { time_min: 0, electricity_kwh: 3.5 },
    });
    const calls = judgeCalls(h);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.data).toMatchObject({
      bet: "do_nothing",
      chore: "get through the day without the heater",
      evidence: "one tap",
    });
  });

  it("AC-016.3: Too cold, I used it loses 25 points and saves nothing", async () => {
    const h = await setup();
    const bet = await betAndWait(h);
    const { status, body } = await tap(h, bet.id, "heater_cold");
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({ verdict: "small_loss", points: -25, saved: null });
    const total = (await h.get("/api/today")).json<{ points: { total: number } }>().points.total;
    expect(total).toBe(-25);
  });

  it("AC-016.3: the bet cannot be settled before its settle time", async () => {
    const h = await setup();
    const card = await heaterCard(h);
    const placed = await h.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote!.id,
      kind: "do_nothing",
    });
    const bet = placed.json<BetJson>();
    expect((await tap(h, bet.id, "heater_fine")).status).toBe(409);
  });

  it("AC-016.3, AC-012.1: the frost backstop overrides the bet: a Do it now alert, no odds, no bet", async () => {
    const h = await setup({ weatherProfile: FAKE_WEATHER_PROFILES.frost });
    const card = await heaterCard(h);
    expect(card).toMatchObject({ kind: "alert", quote: null });
    expect(card.alert_reason).toMatch(/frost|cold/i);
    const bet = await h.post("/api/bets", { card_id: card.id, quote_id: 1, kind: "do_nothing" });
    expect(bet.statusCode).toBe(409);
  });

  it("AC-016.5: a household without a heater this season still gets 'Not needed this season'", async () => {
    const h = await setup({ household: { ...USED, heaterThisSeason: false } });
    expect(await heaterCard(h)).toMatchObject({ notice: "Not needed this season", quote: null });
  });

  it("AC-029.2: with the heater flag off the chore reads Coming later and no bet is possible", async () => {
    const h = await setup({ flags: {} });
    const card = await heaterCard(h);
    expect(card).toMatchObject({ kind: "coming_later", notice: "Coming later", quote: null });
    const bet = await h.post("/api/bets", { card_id: card.id, quote_id: 1, kind: "do_nothing" });
    expect(bet.statusCode).toBe(409);
  });
});
