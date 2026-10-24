import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { CHORES, clampSettleAt, type ChoreType } from "../src/domain/chores.js";
import {
  BACKTEST_CHORES,
  OUTCOME_CHORES,
  RAIN_CHORES,
  outcomeLabel,
  rainWindow,
  type RainChore,
} from "../src/domain/outcomes.js";
import { ruleQuote } from "../src/domain/rules/index.js";
import { HOUR_MS, madridWallTime } from "../src/domain/time.js";
import { loadRules } from "../src/server/rules.js";
import { assertRainConfig } from "../src/server/rain-config.js";
import { loadSavings } from "../src/server/savings.js";
import { RAIN_CHORE_TYPES } from "../src/web/api.js";
import {
  FAKE_WEATHER_PROFILES,
  fakeForecastHours,
  fakeRecordedHours,
  type FakeWeatherProfile,
} from "../src/server/weather/fake.js";

import { createCoreHarness, pair, uploadPhoto, type CoreHarness } from "./core-helpers.js";
import { LOCAL_ORIGIN, T0 } from "./helpers.js";
import { multipartBody, syntheticPhoto } from "./support/photos.js";
import {
  judgeCalls,
  MINUTE,
  settlementOf,
  statusOf,
  tap,
  type SettleBody,
} from "./support/settle.js";

interface CardJson {
  id: number;
  kind: string;
  chore_type: string;
  title: string;
  notice: string | null;
  quote: null | { id: number; band: number; odds: number; source: string; settle_at: string };
  savings_estimate?: { assumption: string; basis: string; water_l: number; time_min?: number };
}
interface BetJson {
  id: number;
  odds: number;
  settle_at: string;
}

/** 5 mm of rain in five hours from 12:00 Madrid: the car's band 3 (likely, 70%). */
const RAIN_5MM: FakeWeatherProfile = {
  temperatureC: 15,
  dryProbabilityPct: 10,
  rain: { startsAfterHours: 2, hours: 5, mmPerHour: 1 },
};
const DRY: FakeWeatherProfile = { temperatureC: 15, dryProbabilityPct: 0 };

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<CoreHarness> {
  harness = await createCoreHarness({
    flags: { rainChores: true },
    weatherProfile: RAIN_5MM,
    ...options,
  });
  await pair(harness);
  return harness;
}

async function quickCard(h: CoreHarness, choreType: string): Promise<CardJson> {
  const response = await h.post("/api/cards/quick", { chore_type: choreType });
  expect(response.statusCode).toBe(201);
  const card = response.json<CardJson>();
  await h.idle();
  return (await h.get(`/api/cards/${card.id}`)).json<CardJson>();
}

/** A card, a do-nothing bet on it and the clock just past its settle time. */
async function betAndWait(h: CoreHarness, choreType: string): Promise<BetJson> {
  const card = await quickCard(h, choreType);
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

async function sendAfterPhoto(h: CoreHarness, betId: number) {
  const body = multipartBody(await syntheticPhoto());
  const response = await h.request({
    method: "POST",
    url: `/api/bets/${betId}/settle`,
    payload: body.payload,
    headers: { cookie: h.cookie, origin: LOCAL_ORIGIN, ...body.headers },
  });
  return { status: response.statusCode, body: response.json<SettleBody>() };
}

const madrid = (day: number, hour: number, minute = 0): number =>
  madridWallTime(Date.UTC(2026, 9, day, 12), 0, hour, minute);

describe("AC-030.1: the rain bets are behind the rainChores flag", () => {
  it("AC-030.1: with the flag off each rain chore is 'Coming later', with no odds and no bet", async () => {
    const h = await setup({ flags: {} });
    for (const type of RAIN_CHORES) {
      const card = await quickCard(h, type);
      expect(card).toMatchObject({ kind: "coming_later", notice: "Coming later", quote: null });
    }
    h.model.setScenario("listener", "rain-chores");
    const { cards } = (await h.post("/api/cards", { text: "the city chores" })).json<{
      cards: CardJson[];
    }>();
    expect(cards.map((c) => [c.chore_type, c.kind, c.notice])).toEqual(
      RAIN_CHORES.map((type) => [type, "coming_later", "Coming later"]),
    );
    expect(h.model.calls.filter((call) => call.job === "bookmaker")).toEqual([]);
  });

  it("AC-030.1: with the flag on the listener sends a car to the normal chore card, and an advice chore stays 'Coming later'", async () => {
    const h = await setup();
    h.model.setScenario("listener", "city-chores");
    const { cards } = (
      await h.post("/api/cards", { text: "wash the car, sweep the balcony and water the plants" })
    ).json<{ cards: CardJson[] }>();
    expect(cards.map((c) => [c.chore_type, c.kind])).toEqual([
      ["car_rinse", "weather"],
      ["balcony_sweep", "coming_later"],
      ["plants", "weather"],
    ]);
    await h.idle();
  });

  it("AC-030.1: the card has rule odds, the title, the sourced savings estimate and a settle slot inside 12-48 h and 08:00-20:00", async () => {
    const h = await setup();
    const card = await quickCard(h, "car_rinse");
    expect(card).toMatchObject({
      kind: "weather",
      title: "Rinse the car",
      quote: { band: 3, odds: 70, source: "rule" },
      savings_estimate: { time_min: 40, water_l: 75, basis: "sourced" },
    });
    // Made at 10:00 Madrid: +12 h is 22:00, so the first settle time is the next morning, 08:00.
    expect(Date.parse(card.quote!.settle_at)).toBe(madrid(23, 8));
  });

  it("AC-030.1: a car bet priced by Gemma is placed with Gemma's band and the rule band stored beside it", async () => {
    const h = await setup();
    h.model.setScenario("bookmaker", "rain-likely");
    const card = await quickCard(h, "car_rinse");
    expect(card.quote).toMatchObject({ source: "gemma", band: 3, odds: 70 });
    expect(h.model.calls.some((call) => call.job === "bookmaker")).toBe(true);
    const bet = (
      await h.post("/api/bets", { card_id: card.id, quote_id: card.quote!.id, kind: "do_nothing" })
    ).json<BetJson>();
    expect(
      h.db.prepare("SELECT odds_source, rule_band FROM bets WHERE id = ?").get(bet.id),
    ).toEqual({ odds_source: "gemma", rule_band: 3 });
  });

  /** One hour of `mm` rain two hours in; every hour reports the given probability. */
  const forecastOf = (mm: number, probability: number) =>
    fakeForecastHours(
      { temperatureC: 15, rain: { startsAfterHours: 2, hours: 1, mmPerHour: mm } },
      T0,
      48,
    ).map((hour) => ({ ...hour, precipitationProbabilityPct: probability }));
  const bandOf = (chore: RainChore, mm: number, probability: number): number | undefined => {
    const window = CHORES[chore].ruleWindow(T0);
    return ruleQuote(chore, forecastOf(mm, probability), window.fromMs, window.toMs, loadRules())
      ?.band;
  };

  it.each([
    ["car_rinse", 0, 0, 0],
    ["car_rinse", 0.1, 0, 1],
    ["car_rinse", 0.9, 0, 1],
    ["car_rinse", 1, 0, 2],
    ["car_rinse", 0.5, 60, 2],
    ["car_rinse", 3.9, 0, 2],
    ["car_rinse", 4, 0, 3],
    ["car_rinse", 7.9, 0, 3],
    ["car_rinse", 8, 0, 4],
    ["bike_rinse", 3.9, 0, 2],
    ["bike_rinse", 4, 0, 3],
    ["bike_rinse", 8, 0, 4],
    ["terrace_rinse", 0.4, 0, 1],
    ["terrace_rinse", 0.5, 0, 2],
    ["terrace_rinse", 0.3, 60, 2],
    ["terrace_rinse", 2, 0, 3],
    ["terrace_rinse", 5, 0, 4],
    ["rain_fill", 0.4, 0, 1],
    ["rain_fill", 0.5, 0, 2],
    ["rain_fill", 1.5, 0, 3],
    ["rain_fill", 4, 0, 4],
  ] as const)(
    "AC-030.1: %s with %s mm and %s%% probability is rule band %i",
    (chore, mm, prob, band) => {
      expect(bandOf(chore, mm, prob)).toBe(band);
    },
  );

  it("AC-030.1: the rule looks at created_at + 24 h for the rinse bets and at next day 08:00 for the barrel", () => {
    for (const chore of ["car_rinse", "bike_rinse", "terrace_rinse"] as const) {
      expect(CHORES[chore].ruleWindow(T0)).toEqual({ fromMs: T0, toMs: T0 + 24 * HOUR_MS });
    }
    expect(CHORES.rain_fill.ruleWindow(T0)).toEqual({ fromMs: T0, toMs: madrid(23, 8) });
    // Rain after the window does not count.
    const late = fakeForecastHours(
      { temperatureC: 15, rain: { startsAfterHours: 30, hours: 1, mmPerHour: 20 } },
      T0,
      48,
    ).map((hour) => ({ ...hour, precipitationProbabilityPct: 0 }));
    const window = CHORES.car_rinse.ruleWindow(T0);
    expect(ruleQuote("car_rinse", late, window.fromMs, window.toMs, loadRules())?.band).toBe(0);
  });

  it("AC-030.1: settle times: Gemma proposes, code moves it into [created + 12 h, created + 48 h] and 08:00-20:00, to the nearest later instant", () => {
    const now = madrid(22, 10);
    // Too early: 12 h is 22:00, so the first slot is 08:00 the next morning.
    expect(clampSettleAt("car_rinse", now, now + 2 * HOUR_MS)).toBe(madrid(23, 8));
    // At night moves later to 08:00.
    expect(clampSettleAt("car_rinse", now, madrid(24, 3))).toBe(madrid(24, 8));
    // Inside a slot stays.
    expect(clampSettleAt("car_rinse", now, madrid(23, 15))).toBe(madrid(23, 15));
    // Past 48 h: the last slot ends at created + 48 h = 10:00 two days later.
    expect(clampSettleAt("terrace_rinse", now, madrid(26, 10))).toBe(madrid(24, 10));
    // Created in the evening: the earliest is 12 h later, at 08:00 if that is at night.
    const evening = madrid(22, 19);
    expect(CHORES.bike_rinse.settleBounds(evening).earliestMs).toBe(madrid(23, 8));
    // The barrel settles the next morning, 08:00 to 12:00.
    expect(clampSettleAt("rain_fill", now, madrid(23, 6))).toBe(madrid(23, 8));
    expect(clampSettleAt("rain_fill", now, madrid(23, 15))).toBe(madrid(23, 12));
  });

  it("AC-030.1: the outcome label is recorded rain over the rule's window: 4 mm car and bike, 2 mm terrace, 1.5 mm barrel", () => {
    const labelOf = (chore: RainChore, mm: number): boolean => {
      const profile: FakeWeatherProfile = {
        temperatureC: 15,
        rain: { startsAfterHours: 1, hours: 1, mmPerHour: mm },
      };
      return outcomeLabel(chore, fakeRecordedHours(profile, T0, 48), rainWindow(chore, T0))
        .delivered;
    };
    expect([3.9, 4].map((mm) => labelOf("car_rinse", mm))).toEqual([false, true]);
    expect([3.9, 4].map((mm) => labelOf("bike_rinse", mm))).toEqual([false, true]);
    expect([1.9, 2].map((mm) => labelOf("terrace_rinse", mm))).toEqual([false, true]);
    expect([1.4, 1.5].map((mm) => labelOf("rain_fill", mm))).toEqual([false, true]);
  });

  it("AC-030.1: the savings figures: the car is sourced to the UB page, the rest are typical estimates", () => {
    const rain = loadSavings().rain!;
    expect(rain.car_rinse).toMatchObject({
      time_min: 40,
      water_l: 75,
      basis: "sourced",
      source: "https://ub.edu/ossma/en?p=37419",
    });
    expect(rain.bike_rinse).toMatchObject({ time_min: 10, water_l: 20, basis: "typical estimate" });
    expect(rain.terrace_rinse).toMatchObject({ time_min: 15, water_l: 30 });
    expect(rain.rain_fill).toMatchObject({ time_min: 5, water_l: 20 });
  });

  it("AC-030.1: the safety backstop applies: a heat wave turns the car card into a 'Do it now' alert", async () => {
    const h = await setup({ weatherProfile: FAKE_WEATHER_PROFILES.heatwave });
    const card = await quickCard(h, "car_rinse");
    expect(card).toMatchObject({ kind: "alert", quote: null });
  });
});

describe("AC-030.2: evidence, judge answers and the dusty-rain loss", () => {
  it("AC-030.2: a 'Clean enough' tap settles the car bet as a win paid at one tap (x0.5), with the sourced saving", async () => {
    const h = await setup();
    const bet = await betAndWait(h, "car_rinse");
    const due = (await h.get("/api/slips")).json<{
      settle_now: { id: number; tap_answers: { id: string; label: string }[] }[];
    }>();
    expect(due.settle_now.find((entry) => entry.id === bet.id)?.tap_answers).toEqual([
      { id: "car_clean", label: "Clean enough" },
      { id: "car_dirty", label: "Still dirty" },
      { id: "car_dirtier", label: "Dirtier than before" },
    ]);
    const { status, body } = await tap(h, bet.id, "car_clean");
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({
      title: "Rinse the car",
      verdict: "win",
      points: 15,
      multiplier: 0.5,
      evidence: { kind: "tap" },
      saved: { time_min: 40, water_l: 75, basis: "sourced" },
    });
  });

  it("AC-030.2: an after photo settles a rinse bet and pays in full (x1.0)", async () => {
    const h = await setup();
    const bet = await betAndWait(h, "bike_rinse");
    const { status, body } = await sendAfterPhoto(h, bet.id);
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({
      verdict: "win",
      multiplier: 1,
      points: 100 - bet.odds,
      evidence: { kind: "photo" },
    });
    // No before photo exists for these chores: the judge sees the after photo only.
    expect(judgeCalls(h)[0]?.images).toBe(1);
  });

  it("AC-030.2: the barrel settles by one tap, and a photo is accepted too", async () => {
    const h = await setup();
    const tapped = await betAndWait(h, "rain_fill");
    expect(CHORES.rain_fill.tapAnswers.map((a) => a.label)).toEqual(["Filled up", "Still low"]);
    expect((await tap(h, tapped.id, "fill_full")).body.receipt).toMatchObject({
      verdict: "win",
      multiplier: 0.5,
    });
  });

  it("AC-030.2: a photo on the barrel bet pays x1.0 like any photo", async () => {
    const h = await setup();
    const bet = await betAndWait(h, "rain_fill");
    const { body } = await sendAfterPhoto(h, bet.id);
    expect(body.receipt).toMatchObject({ verdict: "win", multiplier: 1 });
  });

  it("AC-030.2: 'Dirtier than before' (dusty rain, even with 5 mm recorded) is a loss of -50 and saves nothing", async () => {
    const h = await setup();
    const bet = await betAndWait(h, "car_rinse");
    const { body } = await tap(h, bet.id, "car_dirtier");
    expect(body.receipt).toMatchObject({
      outcome: "loss",
      verdict: "normal_loss",
      points: -50,
      saved: null,
    });
    const call = judgeCalls(h)[0];
    expect(call?.data["person_answered"]).toBe("Dirtier than before");
    expect(call?.data["recorded_weather"]).not.toBeNull();
  });

  it.each(["car_dirty", "car_dirtier"])(
    "AC-030.2: a win verdict on a '%s' tap is invalid, retried once, and the bet keeps waiting",
    async (answer) => {
      const h = await setup();
      const bet = await betAndWait(h, "car_rinse");
      h.model.setScenario("judge", "rain-win-on-loss-tap");
      const { body } = await tap(h, bet.id, answer);
      expect(body.state).toBe("awaiting_gemma");
      expect(statusOf(h, bet.id)).toBe("awaiting_gemma");
      expect(judgeCalls(h)).toHaveLength(2);
    },
  );

  it("AC-030.2: a win verdict on a 'Still low' tap is invalid too", async () => {
    const h = await setup();
    const bet = await betAndWait(h, "rain_fill");
    h.model.setScenario("judge", "rain-win-on-loss-tap");
    expect((await tap(h, bet.id, "fill_low")).body.state).toBe("awaiting_gemma");
  });

  it("AC-030.2: harmful_loss is invalid for these chores (retried once)", async () => {
    const h = await setup();
    const bet = await betAndWait(h, "terrace_rinse");
    h.model.setScenario("judge", "rain-harmful-loss");
    expect((await tap(h, bet.id, "terrace_dirty")).body.state).toBe("awaiting_gemma");
    expect(judgeCalls(h)).toHaveLength(2);
  });

  it("AC-030.2: a win on a 'Clean enough' tap is still valid (the check only blocks loss taps)", async () => {
    const h = await setup();
    const bet = await betAndWait(h, "terrace_rinse");
    h.model.setScenario("judge", "rain-win");
    expect((await tap(h, bet.id, "terrace_rinsed")).body.receipt?.verdict).toBe("win");
  });

  it("AC-030.2: no before photo or inspector step: a before photo on a rain card is refused", async () => {
    const h = await setup();
    const card = await quickCard(h, "car_rinse");
    const response = await uploadPhoto(h, card.id, await syntheticPhoto());
    expect(response.statusCode).toBe(409);
    expect(h.model.calls.some((call) => call.job === "inspector")).toBe(false);
  });

  it("AC-030.2: the lucky flag is computed by code from the rain over created_at + 24 h", async () => {
    // Settled after the window closed: 5 mm of rain is delivered (not lucky), a dry day is lucky.
    const wet = await setup();
    const wetBet = await betAndWait(wet, "car_rinse");
    wet.clock.current = T0 + 25 * HOUR_MS;
    await tap(wet, wetBet.id, "car_clean");
    expect(settlementOf(wet, wetBet.id)["lucky_win"]).toBe(0);
    await wet.close();

    const dry = await setup({ weatherProfile: DRY });
    const dryBet = await betAndWait(dry, "car_rinse");
    dry.clock.current = T0 + 25 * HOUR_MS;
    await tap(dry, dryBet.id, "car_clean");
    expect(settlementOf(dry, dryBet.id)["lucky_win"]).toBe(1);
  });

  /** A card made at 20:00 settles at 08:00, 12 h in: the 24 h label window is still open. */
  async function earlySettle(profile: FakeWeatherProfile): Promise<{ h: CoreHarness; id: number }> {
    const h = await setup({ weatherProfile: profile });
    h.clock.current = T0 + 10 * HOUR_MS;
    const bet = await betAndWait(h, "car_rinse");
    expect(Date.parse(bet.settle_at)).toBe(T0 + 22 * HOUR_MS);
    await tap(h, bet.id, "car_clean");
    return { h, id: bet.id };
  }

  it("AC-030.2: settled at +12 h with 3 mm so far, the lucky flag is unknown (NULL), not lucky", async () => {
    const { h, id } = await earlySettle({
      temperatureC: 15,
      dryProbabilityPct: 10,
      rain: { startsAfterHours: 1, hours: 3, mmPerHour: 1 },
    });
    expect(settlementOf(h, id)["lucky_win"]).toBeNull();
  });

  it("AC-030.2: settled at +12 h with 4 mm or more already, the label is delivered: not lucky", async () => {
    const { h, id } = await earlySettle({
      temperatureC: 15,
      dryProbabilityPct: 10,
      rain: { startsAfterHours: 1, hours: 4, mmPerHour: 1 },
    });
    expect(settlementOf(h, id)["lucky_win"]).toBe(0);
  });
});

describe("AC-030.3: nothing changes for the backtest, the dataset or the calibration", () => {
  it("AC-030.3: the backtest chores are the five of REQ-016 and exclude the rain bets", () => {
    expect([...BACKTEST_CHORES]).toEqual([
      "plants",
      "laundry_line",
      "laundry_tonight",
      "ac",
      "heater",
    ]);
    for (const chore of RAIN_CHORES) {
      expect((BACKTEST_CHORES as readonly string[]).includes(chore)).toBe(false);
      expect(OUTCOME_CHORES.includes(chore)).toBe(true);
    }
    expect(OUTCOME_CHORES).toHaveLength(9);
  });

  it("AC-030.3: config/rules.json and the backtest's savings catalogue are byte-for-byte the ones of before", () => {
    const sha = (file: string): string =>
      createHash("sha256")
        .update(readFileSync(new URL(`../config/${file}`, import.meta.url)))
        .digest("hex");
    expect(sha("rules.json")).toBe(
      "2461b31d6dffa4582559a32045f116dc22c8161b2a543da9b39356b2fe3fa559",
    );
    // The backtest loads savings.json by path: five chores, no rain key, so its hash is unchanged.
    const catalogue = loadSavings(new URL("../config/savings.json", import.meta.url).pathname);
    expect(Object.keys(catalogue).sort()).toEqual(
      ["ac", "heater", "laundry_line", "laundry_tonight", "plants"].sort(),
    );
    expect(
      loadRules(new URL("../config/rules.json", import.meta.url).pathname).rain,
    ).toBeUndefined();
    expect(loadRules().rain).toBeDefined();
  });

  it("AC-030.3: a settled city rain bet counts for points and savings but not for the Score calibration", async () => {
    const h = await setup({ flags: { rainChores: true, score: true } });
    const bet = await betAndWait(h, "car_rinse");
    await tap(h, bet.id, "car_clean");
    const score = (await h.get("/api/score")).json<{
      points: { total: number };
      savings: { wins: number; water_l: number };
      calibration: {
        settled: number;
        rule: { n: number }[];
        gemma: { n: number }[];
        lucky_wins: { wins_labelled: number };
        fake_model_bets: number;
      };
    }>();
    expect(score.points.total).toBe(15);
    expect(score.savings).toMatchObject({ wins: 1, water_l: 75 });
    expect(score.calibration.settled).toBe(0);
    expect(score.calibration.rule.every((band) => band.n === 0)).toBe(true);
    expect(score.calibration.gemma.every((band) => band.n === 0)).toBe(true);
    expect(score.calibration.lucky_wins.wins_labelled).toBe(0);
  });
});

describe("start-up and drift checks", () => {
  it("AC-030.1: with rainChores on, a missing rules-rain.json or rain savings row stops the start", () => {
    const rules = loadRules();
    const savings = loadSavings();
    expect(() => assertRainConfig({ rainChores: true }, rules, savings)).not.toThrow();
    expect(() => assertRainConfig({ rainChores: true }, {}, savings)).toThrow(
      /rules-rain\.json is missing/,
    );
    expect(() =>
      assertRainConfig({ rainChores: true }, rules, {
        rain: { ...savings.rain!, rain_fill: undefined as never },
      }),
    ).toThrow(/no rain row for rain_fill/);
    expect(() => assertRainConfig({ rainChores: true }, rules, {})).toThrow(/car_rinse/);
    // With the flag off nothing is required.
    expect(() => assertRainConfig({ rainChores: false }, {}, {})).not.toThrow();
  });

  it("the web list of rain chore types equals the domain list", () => {
    expect([...RAIN_CHORE_TYPES]).toEqual([...RAIN_CHORES]);
  });

  it("AC-030.1: a card made at 00:30 prices the barrel to 08:00 the next calendar day and settles 08:00-12:00 that day", () => {
    const now = madrid(23, 0, 30);
    expect(CHORES.rain_fill.ruleWindow(now)).toEqual({ fromMs: now, toMs: madrid(24, 8) });
    expect(rainWindow("rain_fill", now).endMs).toBe(madrid(24, 8));
    expect(CHORES.rain_fill.settleBounds(now)).toEqual({
      earliestMs: madrid(24, 8),
      latestMs: madrid(24, 12),
    });
  });
});

describe("chore specs", () => {
  it("every rain chore has a title, unique tap ids, a loss answer and no harmful loss", () => {
    for (const type of RAIN_CHORES as readonly ChoreType[]) {
      const spec = CHORES[type];
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.noHarmfulLoss).toBe(true);
      expect(spec.tapAnswers.some((answer) => answer.isLoss === true)).toBe(true);
    }
  });
});
