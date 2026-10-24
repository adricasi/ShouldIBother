import { afterEach, describe, expect, it } from "vitest";

import {
  LAUNDRY_TONIGHT_OFFER,
  clampSettleAt,
  laundryTonightNotice,
  laundryTonightOffer,
} from "../src/domain/chores.js";
import { MissingSunsetError, cutWindowOf, labelWindowOf } from "../src/domain/lucky-win.js";
import { HOUR_MS, madridWallTimeToEpochMs } from "../src/domain/time.js";
import { ruleWindowAt } from "../src/server/ledger/chore-rules.js";
import { FAKE_WEATHER_PROFILES, type FakeWeatherProfile } from "../src/server/weather/fake.js";
import { OpenMeteoWeatherClient } from "../src/server/weather/open-meteo-client.js";

import {
  createCoreHarness,
  pair,
  type CoreHarness,
  type CoreHarnessOptions,
} from "./core-helpers.js";
import { GatedModel, type BetJson, type CardJson } from "./gemma-support.js";
import { FakeClock } from "./helpers.js";
import { FakeOpenMeteo } from "./support/fake-open-meteo.js";
import { seedBet, settlementOf, tap } from "./support/settle.js";

const GRACIA = { latitude: 41.4045, longitude: 2.1555 };
const TODAY = "2026-10-22";
const TOMORROW = "2026-10-23";
const at = (date: string, time: string): number => madridWallTimeToEpochMs(date, time);
/** The synthetic sunset of the fake weather: 20:00 Madrid time. */
const SUNSET = at(TODAY, "20:00");

let harness: CoreHarness | undefined;
let server: FakeOpenMeteo | undefined;
afterEach(async () => {
  await harness?.close();
  await server?.stop();
  harness = undefined;
  server = undefined;
});

async function setup(options: CoreHarnessOptions = {}, time = "20:30"): Promise<CoreHarness> {
  harness = await createCoreHarness({ flags: { laundryTonight: true }, ...options });
  harness.clock.current = at(TODAY, time);
  await pair(harness);
  return harness;
}

/** The app on the real Open-Meteo client talking to a fake HTTP server, at `time` on TODAY. */
async function setupLive(
  profile: FakeWeatherProfile,
  time: string,
  configure: (fake: FakeOpenMeteo) => void = () => undefined,
  options: { requestSunset?: boolean; logLines?: string[] } = {},
): Promise<{ h: CoreHarness; fake: FakeOpenMeteo }> {
  const clock = new FakeClock();
  clock.current = at(TODAY, time);
  const fake = new FakeOpenMeteo(clock.now);
  fake.profile = profile;
  configure(fake);
  await fake.start();
  server = fake;
  harness = await createCoreHarness({
    clock,
    flags: { laundryTonight: true },
    ...(options.logLines === undefined ? {} : { logLines: options.logLines }),
    liveWeather: (db, now) =>
      new OpenMeteoWeatherClient({
        db,
        now,
        location: GRACIA,
        fetch: fake.transport,
        sleep: () => Promise.resolve(),
        random: () => 0,
        requestSunset: options.requestSunset ?? true,
      }),
  });
  await pair(harness);
  return { h: harness, fake };
}

async function quick(h: CoreHarness, choreType = "laundry_tonight"): Promise<CardJson> {
  const response = await h.post("/api/cards/quick", { chore_type: choreType });
  expect(response.statusCode).toBe(201);
  return response.json<CardJson>();
}

const sunsetOfCard = (h: CoreHarness, id: number): number | null | undefined =>
  h.db
    .prepare<[number], { sunset_at: number | null }>("SELECT sunset_at FROM cards WHERE id = ?")
    .get(id)?.sunset_at;

describe("AC-016.2: the offer window is 1 h before to 2 h after sunset", () => {
  it("AC-016.2: offered from 1 h before sunset (included) to 2 h after sunset (excluded)", () => {
    const { beforeSunsetMs, afterSunsetMs } = LAUNDRY_TONIGHT_OFFER;
    expect([beforeSunsetMs, afterSunsetMs]).toEqual([HOUR_MS, 2 * HOUR_MS]);
    const offer = (nowMs: number) => laundryTonightOffer(nowMs, SUNSET, SUNSET + 24 * HOUR_MS);
    expect(offer(SUNSET - HOUR_MS - 1)).toMatchObject({ offered: false });
    expect(offer(SUNSET - HOUR_MS)).toEqual({ offered: true });
    expect(offer(SUNSET)).toEqual({ offered: true });
    expect(offer(SUNSET + 2 * HOUR_MS - 1)).toEqual({ offered: true });
    expect(offer(SUNSET + 2 * HOUR_MS)).toMatchObject({ offered: false });
  });

  it("AC-016.2: before the window the next chance is 1 h before today's sunset; after it, tomorrow's", () => {
    const tomorrowSunset = at(TOMORROW, "19:58");
    expect(laundryTonightOffer(SUNSET - 2 * HOUR_MS, SUNSET, tomorrowSunset)).toEqual({
      offered: false,
      nextAtMs: SUNSET - HOUR_MS,
    });
    expect(laundryTonightOffer(SUNSET + 3 * HOUR_MS, SUNSET, tomorrowSunset)).toEqual({
      offered: false,
      nextAtMs: tomorrowSunset - HOUR_MS,
    });
    // Without tomorrow's sunset no time is invented.
    expect(laundryTonightOffer(SUNSET + 3 * HOUR_MS, SUNSET)).toEqual({
      offered: false,
      nextAtMs: undefined,
    });
  });

  it("AC-016.2: the card text says when it can be offered", () => {
    const now = at(TODAY, "17:00");
    expect(laundryTonightNotice(now, SUNSET - HOUR_MS)).toBe(
      "Offered from 1 h before to 2 h after sunset. Next chance: today at 19:00.",
    );
    expect(laundryTonightNotice(at(TODAY, "23:00"), at(TOMORROW, "18:58"))).toBe(
      "Offered from 1 h before to 2 h after sunset. Next chance: tomorrow at 18:58.",
    );
    expect(laundryTonightNotice(at(TODAY, "23:00"), undefined)).toBe(
      "Offered from 1 h before to 2 h after sunset. Next chance: tomorrow evening.",
    );
  });

  it.each([
    ["18:59", "Next chance: today at 19:00."],
    ["22:00", "Next chance: tomorrow at 19:00."],
    ["23:30", "Next chance: tomorrow at 19:00."],
  ])(
    "AC-016.2: a card made at %s says when it can be offered, with no odds and no bet action",
    async (time, next) => {
      const h = await setup({}, time);
      const card = await quick(h);
      expect(card).toMatchObject({
        kind: "coming_later",
        quote: null,
        alert_reason: null,
        notice: `Offered from 1 h before to 2 h after sunset. ${next}`,
      });
      expect(
        (await h.post("/api/bets", { card_id: card.id, quote_id: 1, kind: "do_nothing" }))
          .statusCode,
      ).toBe(409);
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
    },
  );

  it.each(["19:00", "20:00", "21:59"])(
    "AC-016.2: a card made at %s is offered with rule odds and its settle time the next morning",
    async (time) => {
      const h = await setup({}, time);
      const card = await quick(h);
      expect(card).toMatchObject({
        kind: "weather",
        title: "Leave it out tonight",
        notice: null,
        quote: { source: "rule", settle_at: new Date(at(TOMORROW, "08:00")).toISOString() },
      });
      await h.idle();
    },
  );

  it("AC-016.2: the sunset the card was priced on is stored on it, and never changes", async () => {
    const h = await setup();
    const card = await quick(h);
    expect(sunsetOfCard(h, card.id)).toBe(SUNSET);
    expect(() =>
      h.db.prepare("UPDATE cards SET sunset_at = ? WHERE id = ?").run(1, card.id),
    ).toThrow(/sunset_at cannot be updated/);
    expect(sunsetOfCard(h, card.id)).toBe(SUNSET);
    // Other cards carry none.
    const plants = await quick(h, "plants");
    expect(sunsetOfCard(h, plants.id)).toBeNull();
  });

  it("REQ-029: with the laundryTonight flag off the chore reads Coming later, in the window too", async () => {
    const h = await setup({ flags: {} });
    expect(await quick(h)).toMatchObject({ kind: "coming_later", notice: "Coming later" });
  });

  it("AC-014.4: when the forecast has no sunset the card cannot be priced and says so", async () => {
    const h = await setup();
    h.weather.sunsets = false;
    expect(await quick(h)).toMatchObject({
      kind: "coming_later",
      notice: "No forecast, can't set odds",
      quote: null,
    });
  });

  it("AC-014.4: when the weather service is down the card says so", async () => {
    const h = await setup();
    h.weather.failWith = new Error("down");
    expect(await quick(h)).toMatchObject({ notice: "No forecast, can't set odds" });
  });
});

describe("AC-016.2: the window and the rule start at sunset", () => {
  it("AC-016.2: the rule window is sunset to 08:00 next day, even for a card made later that evening", () => {
    const now = at(TODAY, "21:30");
    expect(ruleWindowAt("laundry_tonight", now, at(TOMORROW, "08:00"), SUNSET)).toEqual({
      fromMs: SUNSET,
      toMs: at(TOMORROW, "08:00"),
    });
  });

  it("AC-016.2, AC-004.1: a wet hour after sunset but before the card was made counts (window from sunset, not from now)", async () => {
    // The fake server's rain is counted from midnight: one wet hour at 20:00, the sunset hour.
    const { h } = await setupLive(
      {
        temperatureC: 19,
        dryProbabilityPct: 0,
        rain: { startsAfterHours: 20, hours: 1, mmPerHour: 1 },
      },
      "21:30",
    );
    const card = await quick(h);
    // Any wet hour in sunset to 08:00 is "very unlikely"; from 21:30 on it would have been dry.
    expect(card).toMatchObject({ kind: "weather", quote: { source: "rule", band: 0 } });
    await h.idle();
  });

  it("AC-012.1: the backstop looks at the same window: frost between sunset and 08:00 is an alert", async () => {
    const h = await setup({ weatherProfile: FAKE_WEATHER_PROFILES.frost });
    expect(await quick(h)).toMatchObject({
      kind: "alert",
      alert_reason: "Frost: down to 1 °C is forecast.",
      quote: null,
    });
    expect(h.model.calls).toHaveLength(0);
  });

  it("AC-016.2: the live client asks for the daily sunset and stores it on the card", async () => {
    const { h, fake } = await setupLive(FAKE_WEATHER_PROFILES.mild, "20:30");
    const card = await quick(h);
    expect(card.kind).toBe("weather");
    expect(sunsetOfCard(h, card.id)).toBe(SUNSET);
    expect(fake.forecastRequests[0]?.searchParams.get("daily")).toBe("sunset");
    // Recorded-weather requests do not carry it.
    expect(fake.recordedRequests.every((url) => !url.searchParams.has("daily"))).toBe(true);
    await h.idle();
  });

  it("AC-016.2: when the answer has no daily sunset, the start of the last daylight hour stands in and is logged", async () => {
    const logLines: string[] = [];
    const { h } = await setupLive(
      FAKE_WEATHER_PROFILES.mild,
      "20:30",
      (fake) => {
        fake.omitDaily = true;
      },
      { logLines },
    );
    const card = await quick(h);
    expect(card.kind).toBe("weather");
    // Daylight runs to 20:00, so its last hour starts at 19:00: that hour is inside the window.
    expect(sunsetOfCard(h, card.id)).toBe(at(TODAY, "19:00"));
    expect(logLines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ event: "sunset_fallback", date: TODAY }),
    );
    await h.idle();
  });

  it("AC-016.2: the daily sunset is not logged as a fallback", async () => {
    const logLines: string[] = [];
    const { h } = await setupLive(FAKE_WEATHER_PROFILES.mild, "20:30", () => undefined, {
      logLines,
    });
    await quick(h);
    expect(logLines.join("")).not.toContain("sunset_fallback");
    await h.idle();
  });

  it("REQ-029: with the laundryTonight flag off the forecast request is the one it was before: no daily sunset", async () => {
    const { h, fake } = await setupLive(FAKE_WEATHER_PROFILES.mild, "20:30", () => undefined, {
      requestSunset: false,
    });
    expect((await quick(h, "plants")).kind).toBe("weather");
    expect(fake.forecastRequests[0]?.searchParams.has("daily")).toBe(false);
    expect([...fake.forecastRequests[0]!.searchParams.keys()].sort()).toEqual([
      "forecast_days",
      "hourly",
      "latitude",
      "longitude",
      "past_days",
      "timeformat",
      "timezone",
    ]);
    await h.idle();
  });
});

describe("AC-016.2: Gemma bookmakes the card on the same window", () => {
  it("AC-016.2, AC-003.1: Gemma's quote is clamped to 08:00 to 10:00 next day and the rule band is stored for that window", async () => {
    const model = new GatedModel();
    model.setScenario("bookmaker", "laundry-tonight-ok");
    const h = await setup({ model });
    const created = await quick(h);
    await h.idle();
    const after = (await h.get(`/api/cards/${created.id}`)).json<CardJson>();
    expect(after).toMatchObject({
      kind: "weather",
      gemma: { state: "answered" },
      // 11 h from 20:30 is 07:30: clamped up to the earliest settle time.
      quote: { source: "gemma", band: 3, settle_at: new Date(at(TOMORROW, "08:00")).toISOString() },
    });
    expect(clampSettleAt("laundry_tonight", at(TODAY, "20:30"), at(TOMORROW, "07:30"))).toBe(
      at(TOMORROW, "08:00"),
    );
    const call = model.calls.find((c) => c.job === "bookmaker")!;
    const user = call.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("leave the laundry out overnight");
  });

  it("AC-012.3, AC-016.2: the safety guard sees the window from sunset", async () => {
    const model = new GatedModel();
    model.setScenario("safety", "ok");
    model.setScenario("bookmaker", "laundry-tonight-ok");
    const h = await setup({ model, flags: { laundryTonight: true, safetyGuard: true } }, "21:30");
    await quick(h);
    await h.idle();
    const call = model.calls.find((c) => c.job === "safety")!;
    const user = call.messages.find((m) => m.role === "user")!.content;
    const data = JSON.parse(user.split("\n")[1]!) as {
      window_europe_madrid: { from: string; to: string };
      forecast: { time: string }[];
    };
    expect(data.window_europe_madrid).toEqual({ from: "2026-10-22 20:00", to: "2026-10-23 08:00" });
    expect(data.forecast[0]?.time).toBe("2026-10-22 20:00");
  });
});

describe("AC-016.2: settlement through the existing Settler and judge", () => {
  async function placeOnCard(h: CoreHarness): Promise<{ card: CardJson; bet: BetJson }> {
    const card = await quick(h);
    await h.idle();
    const response = await h.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote?.id,
      kind: "do_nothing",
    });
    expect(response.statusCode).toBe(201);
    return { card, bet: response.json<BetJson>() };
  }

  it("AC-016.2, AC-008.6: a dry morning is a win; the lucky flag is labelled on the window from the stored sunset", async () => {
    const h = await setup();
    const { bet } = await placeOnCard(h);
    h.clock.current = at(TOMORROW, "08:30");
    const { body } = await tap(h, bet.id, "tonight_dry");
    expect(body.state).toBe("settled");
    expect(body.receipt).toMatchObject({
      title: "Leave it out tonight",
      verdict: "win",
      multiplier: 0.5,
      evidence: { kind: "tap" },
      answer: "Dry this morning",
      // Mild, dry, 8 degrees of dew spread: the weather delivered, so not lucky.
      lucky_win: false,
    });
    expect(body.receipt?.points).toBe(Math.round((100 - bet.odds) * 0.5));
    // The label's recorded hours start at sunset, not at the moment the bet was placed.
    expect(h.weather.recordedRequests).toContainEqual({
      fromMs: SUNSET,
      toMs: at(TOMORROW, "08:00"),
    });
  });

  it("AC-016.2, AC-008.6: dew on the line is a lucky win when the person still says it is dry", async () => {
    const h = await setup({
      weatherProfile: { temperatureC: 12, dryProbabilityPct: 0, dewSpreadC: 1 },
    });
    const { bet } = await placeOnCard(h);
    h.clock.current = at(TOMORROW, "08:30");
    const { body } = await tap(h, bet.id, "tonight_dry");
    expect(body.receipt).toMatchObject({ verdict: "win", lucky_win: true });
    expect(settlementOf(h, bet.id)).toMatchObject({ verdict: "win", lucky_win: 1 });
  });

  it.each([
    ["tonight_damp", "small_loss", -25],
    ["tonight_wet", "normal_loss", -50],
  ])(
    "AC-016.2: '%s' (dew or rain dampened it) is a %s, %i points, whatever the evidence",
    async (answer, verdict, points) => {
      const h = await setup();
      const { bet } = await placeOnCard(h);
      h.clock.current = at(TOMORROW, "08:30");
      const { body } = await tap(h, bet.id, answer);
      expect(body.receipt).toMatchObject({ verdict, points, lucky_win: null });
    },
  );

  it("AC-008.6: a bet whose card stored no sunset still pays; its lucky flag is unknown", async () => {
    const h = await setup();
    h.clock.current = at(TOMORROW, "08:30");
    const betId = seedBet(h, { chore: "laundry_tonight", band: 2, openHours: 12 });
    const { body } = await tap(h, betId, "tonight_dry");
    expect(body.receipt).toMatchObject({ verdict: "win", points: 25, lucky_win: null });
    expect(settlementOf(h, betId)["lucky_win"]).toBeNull();
  });

  it("AC-016.2: a seeded bet with a stored sunset uses it", async () => {
    const h = await setup();
    h.clock.current = at(TOMORROW, "08:30");
    const betId = seedBet(h, {
      chore: "laundry_tonight",
      band: 2,
      openHours: 11,
      sunsetAt: SUNSET,
    });
    const { body } = await tap(h, betId, "tonight_dry");
    expect(body.receipt?.lucky_win).toBe(false);
    expect(h.weather.recordedRequests).toContainEqual({
      fromMs: SUNSET,
      toMs: at(TOMORROW, "08:00"),
    });
  });
});

describe("the lucky-win window of laundry tonight (domain)", () => {
  const placedAt = at(TODAY, "21:30");
  const settleAt = at(TOMORROW, "08:00");

  it("AC-008.6: starts at the stored sunset, ends at 08:00, whenever the bet was placed", () => {
    expect(
      labelWindowOf("laundry_tonight", { placedAt, settleAt, sunsetAt: SUNSET }, settleAt),
    ).toEqual({
      startMs: SUNSET,
      endMs: at(TOMORROW, "08:00"),
    });
  });

  it("AC-008.6: is cut at 'now' only where the hours are not recorded yet", () => {
    const now = at(TOMORROW, "03:00");
    expect(labelWindowOf("laundry_tonight", { placedAt, settleAt, sunsetAt: SUNSET }, now)).toEqual(
      {
        startMs: SUNSET,
        endMs: now,
      },
    );
  });

  it("AC-008.6: the fallback window is the stored one cut to the time the bet was open", () => {
    expect(cutWindowOf("laundry_tonight", { placedAt, settleAt, sunsetAt: SUNSET })).toEqual({
      startMs: placedAt,
      endMs: settleAt,
    });
  });

  it("AC-008.6: without a stored sunset the window is unknown, never the placing time", () => {
    expect(() => labelWindowOf("laundry_tonight", { placedAt, settleAt }, settleAt)).toThrow(
      MissingSunsetError,
    );
    expect(() => cutWindowOf("laundry_tonight", { placedAt, settleAt, sunsetAt: null })).toThrow(
      MissingSunsetError,
    );
  });

  it("AC-008.6: other chores do not need a sunset", () => {
    expect(
      labelWindowOf("laundry_line", { placedAt: at(TODAY, "13:00"), settleAt }, at(TODAY, "18:00")),
    ).toEqual({ startMs: at(TODAY, "10:00"), endMs: at(TODAY, "18:00") });
  });
});

describe("AC-016.2: the night the clocks go back (Sat 24 to Sun 25 Oct 2026)", () => {
  const SAT = "2026-10-24";
  const SUN = "2026-10-25";
  // Sunset on Saturday is about 19:20 CEST; on Sunday, after the change, about 18:25 CET.
  const satSunset = at(SAT, "19:20");
  const sunSunset = at(SUN, "18:25");

  it("the night is 13 h 40 min long: sunset in CEST to 08:00 CET", () => {
    expect(satSunset).toBe(Date.UTC(2026, 9, 24, 17, 20));
    const window = ruleWindowAt(
      "laundry_tonight",
      satSunset + HOUR_MS,
      at(SUN, "08:00"),
      satSunset,
    );
    expect(window).toEqual({ fromMs: satSunset, toMs: Date.UTC(2026, 9, 25, 7, 0) });
    expect(window.toMs - window.fromMs).toBe(13 * HOUR_MS + 40 * 60_000);
  });

  it("Gemma's settle time is clamped to 08:00 to 10:00 CET on Sunday", () => {
    const now = at(SAT, "20:30");
    expect(clampSettleAt("laundry_tonight", now, now + 5 * HOUR_MS)).toBe(
      Date.UTC(2026, 9, 25, 7, 0),
    );
    expect(clampSettleAt("laundry_tonight", now, now + 40 * HOUR_MS)).toBe(
      Date.UTC(2026, 9, 25, 9, 0),
    );
  });

  it("after the window closes the next chance is 1 h before Sunday's earlier sunset", () => {
    const offer = laundryTonightOffer(at(SAT, "22:30"), satSunset, sunSunset);
    expect(offer).toEqual({ offered: false, nextAtMs: at(SUN, "17:25") });
    expect(laundryTonightNotice(at(SAT, "22:30"), at(SUN, "17:25"))).toContain(
      "Next chance: tomorrow at 17:25.",
    );
  });

  it("the label window of a Saturday bet runs sunset to 08:00 CET", () => {
    expect(
      labelWindowOf(
        "laundry_tonight",
        { placedAt: at(SAT, "20:30"), settleAt: at(SUN, "08:00"), sunsetAt: satSunset },
        at(SUN, "09:00"),
      ),
    ).toEqual({ startMs: satSunset, endMs: Date.UTC(2026, 9, 25, 7, 0) });
  });

  it("a card made on Saturday evening settles at 08:00 CET Sunday", async () => {
    const h = await setup({}, "20:30");
    h.clock.current = at(SAT, "20:30");
    const card = await quick(h);
    expect(card).toMatchObject({
      kind: "weather",
      quote: { settle_at: new Date(Date.UTC(2026, 9, 25, 7, 0)).toISOString() },
    });
    await h.idle();
  });
});
