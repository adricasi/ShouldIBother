import { afterEach, describe, expect, it } from "vitest";

import { HOUR_MS, madridWallTimeToEpochMs } from "../src/domain/time.js";
import type { ForecastHour } from "../src/domain/weather.js";
import { advisorOutputSchema } from "../src/server/gemma/advisor.js";
import {
  ADVISOR_MAX_HOURS_AHEAD,
  MAX_HOURS_AHEAD,
  createForecastTool,
} from "../src/server/gemma/forecast-tool.js";
import { JobToolArgumentError } from "../src/server/gemma/runner.js";
import type { Forecast, RecordedWeather, WeatherClient } from "../src/server/weather/client.js";
import { fakeForecastHours, fakeSunsets } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { FakeClock } from "./helpers.js";

const THURSDAY_9 = madridWallTimeToEpochMs("2026-10-22", "09:00");

/** Mild, calm and dry from the hour of the request on, with `change` applied by hour index. */
class ScriptedWeather implements WeatherClient {
  readonly requests: { fromMs: number; hours: number }[] = [];
  fail = false;

  constructor(
    private readonly now: () => number,
    private readonly change: (index: number) => Partial<ForecastHour>,
  ) {}

  latestForecastFetchedAt(): number | undefined {
    return 0;
  }

  getForecast(request: { fromMs: number; hours: number }): Promise<Forecast> {
    this.requests.push({ fromMs: request.fromMs, hours: request.hours });
    if (this.fail) {
      return Promise.reject(new Error("unused"));
    }
    const hours: ForecastHour[] = fakeForecastHours(
      { temperatureC: 18, dryProbabilityPct: 5 },
      request.fromMs,
      request.hours,
    ).map((hour, index) => ({ ...hour, ...this.change(index) }));
    return Promise.resolve({ fetchedAt: this.now(), hours, sunsetMsByDate: fakeSunsets(hours) });
  }

  getRecorded(): Promise<RecordedWeather> {
    return Promise.resolve({ fetchedAt: this.now(), complete: false, hours: [] });
  }
}

const rain =
  (from: number, to: number, mm: number) =>
  (index: number): Partial<ForecastHour> =>
    index >= from && index < to ? { precipitationMm: mm } : {};

/** 8 mm over hours 2 to 9 (Thursday 11:00 to 18:00). */
const RAIN_UNTIL_19 = rain(2, 10, 1);
const CALM = (): Partial<ForecastHour> => ({});
/** A wet hour every 20 hours: never 24 dry hours in a row. */
const SHOWERS = (index: number): Partial<ForecastHour> =>
  index % 20 === 10 ? { precipitationMm: 1 } : {};

interface AdviceCard {
  id: number;
  kind: string;
  title: string;
  notice: string | null;
  quote: unknown;
  chore_type: string;
  advice?: {
    stage: string;
    source: "gemma" | "rule" | null;
    label: string | null;
    advice: string | null;
    headline: string | null;
    reason: string | null;
    window: { from: string; to: string } | null;
    rule: { headline: string | null; reason: string } | null;
    note: string | null;
    can_retry: boolean;
    decision: {
      job: string;
      prompt_version: string;
      tool_mode: string | null;
      forecast: unknown[] | null;
      retries: number;
    } | null;
  };
}

let harness: CoreHarness | undefined;
let weather: ScriptedWeather | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(
  change: (index: number) => Partial<ForecastHour> = RAIN_UNTIL_19,
  flags: Parameters<typeof createCoreHarness>[0] = {},
): Promise<CoreHarness> {
  const clock = new FakeClock();
  clock.current = THURSDAY_9;
  harness = await createCoreHarness({
    clock,
    flags: { adviceCards: true },
    liveWeather: (_db, now) => {
      weather = new ScriptedWeather(now, change);
      return weather;
    },
    ...flags,
  });
  await pair(harness);
  return harness;
}

/** Types a sentence the listener reads as one advice chore, and waits for the advisor. */
async function capture(
  h: CoreHarness,
  listener: string,
  advisor: string,
): Promise<{ created: AdviceCard; card: AdviceCard }> {
  h.model.setScenario("listener", listener);
  h.model.setScenario("advisor", advisor);
  const response = await h.post("/api/cards", { text: "a chore for the weekend" });
  expect(response.statusCode).toBe(201);
  const [created] = response.json<{ cards: AdviceCard[] }>().cards;
  await h.idle();
  const card = (await h.get(`/api/cards/${created!.id}`)).json<AdviceCard>();
  return { created: created!, card };
}

const advisorCalls = (h: CoreHarness) => h.model.calls.filter((call) => call.job === "advisor");

describe("AC-031.1: the advisor gives do it now, wait for a window or no window, with get_forecast over 72 hours", () => {
  it("AC-031.1: while the adviceCards flag is off the four advice chores are 'Coming later' and Gemma is not asked", async () => {
    const h = await setup(CALM, { flags: {} });
    for (const listener of ["advice-windows", "advice-sweep", "advice-paint", "advice-lawn"]) {
      h.model.setScenario("listener", listener);
      const response = await h.post("/api/cards", { text: "a chore" });
      const [card] = response.json<{ cards: (AdviceCard & Record<string, unknown>)[] }>().cards;
      expect(card).toMatchObject({ kind: "coming_later", notice: "Coming later", quote: null });
      expect(card).not.toHaveProperty("advice");
    }
    await h.idle();
    expect(advisorCalls(h)).toHaveLength(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE advice IS NOT NULL").get()).toEqual({
      n: 0,
    });
  });

  it("AC-031.1: with the flag on, a clean-the-windows chore is a card that is thinking, then gives a window", async () => {
    const h = await setup();
    const { created, card } = await capture(h, "advice-windows", "windows-wait-rain");
    expect(created.advice?.stage).toBe("thinking");
    expect(created.advice?.note).toBe("Gemma is checking the forecast.");
    expect(card).toMatchObject({ kind: "weather", title: "Clean the windows", quote: null });
    expect(card.advice).toMatchObject({
      stage: "advice",
      source: "gemma",
      label: "Gemma's advice",
      advice: "wait",
      headline: "Clean the windows after tomorrow 01:00",
    });
    // The reason names the forecast numbers, and the window is in Madrid time (16 h after 09:00).
    expect(card.advice?.reason).toContain("8 mm");
    expect(card.advice?.window).toEqual({
      from: new Date(THURSDAY_9 + 16 * HOUR_MS).toISOString(),
      to: new Date(THURSDAY_9 + 28 * HOUR_MS).toISOString(),
    });
  });

  it("AC-031.1: Gemma is asked with get_forecast, up to 72 hours, and the tool is called", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "windows-wait-rain");
    const calls = advisorCalls(h);
    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual(["get_forecast"]);
    const parameters = calls[0]?.tools?.[0]?.parameters as {
      properties: { hours_ahead: { maximum: number } };
    };
    expect(parameters.properties.hours_ahead.maximum).toBe(72);
    // The tool ran: the second call carries its result, and 72 hours were fetched for it.
    const toolMessage = calls[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("precip_mm");
    expect(weather?.requests.at(-1)).toMatchObject({ hours: 72 });
    expect(card.advice?.decision).toMatchObject({ job: "advisor", tool_mode: "called" });
    // The user text is untrusted data, inside the delimiters.
    const user = calls[0]?.messages.find((message) => message.role === "user")?.content;
    expect(user).toMatch(/^<untrusted_data>/);
    expect(h.model.calls.some((call) => call.job === "bookmaker")).toBe(false);
  });

  it.each([
    ["advice-sweep", "sweep-do-now", CALM, "do_now", "Sweep the balcony now"],
    [
      "advice-paint",
      "paint-no-window",
      SHOWERS,
      "no_window",
      "No good window to paint outdoors in the next 3 days",
    ],
    [
      "advice-lawn",
      "lawn-wait-heavy-rain",
      rain(6, 16, 1.2),
      "wait",
      "Feed the lawn after tomorrow 01:00",
    ],
  ])("AC-031.1: %s with the %s answer shows %s", async (listener, scenario, change, kind, text) => {
    const h = await setup(change);
    const { card } = await capture(h, listener, scenario);
    expect(card.advice).toMatchObject({ source: "gemma", advice: kind, headline: text });
    expect(card.quote).toBeNull();
  });

  it("AC-031.1: the advisor must call the tool: an answer without it is retried and then shows the rule advice", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "no-tool-call");
    expect(card.advice).toMatchObject({ source: "rule", label: "Rule advice", can_retry: true });
    expect(card.advice?.decision?.tool_mode).toBe("missed");
  });

  it("AC-031.1: the advisor's tool takes 72 hours and the bookmaker's stays at 48", async () => {
    const read = (hoursAhead: number) =>
      Promise.resolve(fakeForecastHours({ temperatureC: 18 }, 0, hoursAhead));
    const advisor = createForecastTool(read, {
      required: true,
      injectedHoursAhead: 72,
      maxHoursAhead: ADVISOR_MAX_HOURS_AHEAD,
    });
    const bookmaker = createForecastTool(read, { required: true, injectedHoursAhead: 72 });
    expect(await advisor.execute({ hours_ahead: 72 })).toContain("hours");
    await expect(advisor.execute({ hours_ahead: 73 })).rejects.toBeInstanceOf(JobToolArgumentError);
    expect(await bookmaker.execute({ hours_ahead: MAX_HOURS_AHEAD })).toContain("hours");
    await expect(bookmaker.execute({ hours_ahead: 49 })).rejects.toBeInstanceOf(
      JobToolArgumentError,
    );
    // Even the app-made call of the bookmaker in injected mode stays inside its bound.
    expect(bookmaker.injectedArguments).toEqual({ hours_ahead: 48 });
    expect(
      (bookmaker.definition.parameters as { properties: { hours_ahead: { maximum: number } } })
        .properties.hours_ahead.maximum,
    ).toBe(48);
  });

  it("AC-031.1: the output schema takes ok or unsure with a window only on a wait", () => {
    const ok = { status: "ok", advice: "wait", reason: "8 mm of rain until 19:00." };
    expect(advisorOutputSchema.safeParse(ok).success).toBe(false);
    expect(
      advisorOutputSchema.safeParse({
        ...ok,
        window: { start_hours_ahead: 16, end_hours_ahead: 28 },
      }).success,
    ).toBe(true);
    expect(
      advisorOutputSchema.safeParse({
        ...ok,
        advice: "do_now",
        window: { start_hours_ahead: 0, end_hours_ahead: 3 },
      }).success,
    ).toBe(false);
    expect(
      advisorOutputSchema.safeParse({
        ...ok,
        window: { start_hours_ahead: 30, end_hours_ahead: 30 },
      }).success,
    ).toBe(false);
    expect(
      advisorOutputSchema.safeParse({
        ...ok,
        window: { start_hours_ahead: 30, end_hours_ahead: 73 },
      }).success,
    ).toBe(false);
    expect(advisorOutputSchema.safeParse({ status: "unsure" }).success).toBe(true);
    expect(advisorOutputSchema.safeParse({ status: "ok", advice: "do_now" }).success).toBe(false);
  });
});

describe("AC-031.2: the rule advice, and what happens when Gemma's window is contradicted or Gemma is away", () => {
  it("AC-031.2: the rule advice is computed for every card and shown beside Gemma's when they differ", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "windows-wait-early");
    // Rule: the last wet hour is 9 (ends at 10), plus 6 h: wait from hour 16. Gemma says hour 11.
    expect(card.advice?.source).toBe("gemma");
    expect(card.advice?.headline).toBe("Clean the windows after today 20:00");
    expect(card.advice?.rule).toMatchObject({ headline: "Clean the windows after tomorrow 01:00" });
    expect(card.advice?.rule?.reason).toMatch(/^Rule: 1 mm of rain or more in the next 48 hours/);
  });

  it("AC-031.2: the rule advice is not shown beside Gemma's when they agree", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "windows-wait-rain");
    expect(card.advice?.rule).toBeNull();
  });

  it("AC-031.2: a window the forecast contradicts is refused and retried once, and the valid retry is shown", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "contradicted-then-valid");
    expect(advisorCalls(h)).toHaveLength(4);
    expect(card.advice).toMatchObject({ source: "gemma", label: "Gemma's advice" });
    expect(card.advice?.window?.from).toBe(new Date(THURSDAY_9 + 16 * HOUR_MS).toISOString());
    const retry = advisorCalls(h)[2]?.messages.at(-1)?.content;
    expect(retry).toContain("The forecast contradicts your answer");
    expect(retry).toContain("contains a wet hour");
    expect(
      h.db.prepare("SELECT retries, valid FROM gemma_decisions WHERE job = 'advisor'").all(),
    ).toEqual([{ retries: 1, valid: 1 }]);
  });

  it("AC-031.2: refused twice, the card shows the rule advice labelled 'Rule advice' with Retry", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "contradicted-twice");
    expect(card.advice).toMatchObject({
      stage: "advice",
      source: "rule",
      label: "Rule advice",
      headline: "Clean the windows after tomorrow 01:00",
      note: "Gemma's window was contradicted by the forecast.",
      can_retry: true,
      rule: null,
    });
    // The refused attempt is still disclosed: the decision was made and failed its checks.
    expect(card.advice?.decision).toMatchObject({ job: "advisor", retries: 1 });
    expect(
      h.db.prepare("SELECT valid, retries FROM gemma_decisions WHERE job = 'advisor'").all(),
    ).toEqual([{ valid: 0, retries: 1 }]);
  });

  it("AC-031.2: a paint window with forecast rain is refused", async () => {
    const h = await setup(rain(10, 12, 1));
    const { card } = await capture(h, "advice-paint", "paint-contradicted");
    expect(card.advice).toMatchObject({ source: "rule", label: "Rule advice" });
    // The rule's first 24 dry, mild hours start at hour 12.
    expect(card.advice?.headline).toBe("Paint or varnish outdoors from today 21:00");
  });

  it.each(["offline", "timeout", "invalid-json", "unsure"])(
    "AC-031.2: with Gemma %s the card shows the rule advice, labelled Rule advice, and Retry",
    async (scenario) => {
      const h = await setup();
      const { card } = await capture(h, "advice-windows", scenario);
      expect(card.advice).toMatchObject({
        stage: "advice",
        source: "rule",
        label: "Rule advice",
        advice: "wait",
        can_retry: true,
      });
      expect(card.advice?.reason).toMatch(/^Rule:/);
      expect(card.advice?.note).not.toBeNull();
    },
  );

  it("AC-031.2: Retry asks the advisor again and replaces the rule advice with Gemma's", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "offline");
    expect(card.advice?.source).toBe("rule");
    h.model.setScenario("advisor", "windows-wait-rain");
    const retried = await h.post(`/api/cards/${card.id}/retry`, {});
    expect(retried.statusCode).toBe(200);
    expect(retried.json<AdviceCard>().advice?.stage).toBe("advice");
    await h.idle();
    const after = (await h.get(`/api/cards/${card.id}`)).json<AdviceCard>();
    expect(after.advice).toMatchObject({ source: "gemma", can_retry: false, note: null });
    const answered = await h.post(`/api/cards/${card.id}/retry`, {});
    expect(answered.statusCode).toBe(409);
  });

  it("AC-031.2: with no forecast there is no advice, and the card offers Retry", async () => {
    const h = await setup();
    weather!.fail = true;
    // The scripted client rejects with a plain error: use the real error type through the fake.
    const { WeatherUnavailableError } = await import("../src/server/weather/client.js");
    weather!.getForecast = () => Promise.reject(new WeatherUnavailableError("down"));
    const { card } = await capture(h, "advice-windows", "windows-wait-rain");
    expect(card.advice).toMatchObject({
      stage: "unavailable",
      source: null,
      note: "The forecast was not available.",
      can_retry: true,
    });
    expect(advisorCalls(h)).toHaveLength(0);
  });

  it("AC-031.2: a chore the rules never wait for says do it now on calm weather", async () => {
    const h = await setup(CALM);
    const { card } = await capture(h, "advice-windows", "offline");
    expect(card.advice).toMatchObject({
      source: "rule",
      advice: "do_now",
      headline: "Clean the windows now",
    });
  });
});

describe("AC-031.3: advice cards are advice only, logged, and disclosed", () => {
  it("AC-031.3: an advice card has no quote, takes no bet and no photo, and counts for nothing", async () => {
    const h = await setup();
    const before = (await h.get("/api/today")).json<{
      points: { total: number };
      week: { totals: unknown };
    }>();
    const { card } = await capture(h, "advice-windows", "windows-wait-rain");
    expect(card.quote).toBeNull();
    const bet = await h.post("/api/bets", { card_id: card.id, quote_id: 1, kind: "do_nothing" });
    expect(bet.statusCode).toBe(409);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toEqual({ n: 0 });
    const today = (await h.get("/api/today")).json<{
      points: { total: number };
      week: { totals: unknown };
      cards: AdviceCard[];
    }>();
    // No points, no savings, no time counted.
    expect(today.points.total).toBe(before.points.total);
    expect(today.week.totals).toEqual(before.week.totals);
    expect(today.cards.map((entry) => entry.id)).toEqual([card.id]);
    // No calibration: the card has no bet to be counted in the score.
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE advice_points IS NOT NULL").get(),
    ).toEqual({ n: 0 });
  });

  it("AC-031.3: the advisor decision is logged without household text", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "windows-wait-rain");
    const rows = h.db
      .prepare("SELECT * FROM gemma_decisions WHERE job = 'advisor'")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_id: card.id,
      prompt_version: "advisor.v1",
      valid: 1,
      retries: 0,
      tool_mode: "called",
      input_summary: "advice card windows_clean, 72 forecast hours",
      model: "fake-gemma",
    });
    expect(String(rows[0]?.input_summary)).not.toContain("a chore");
    const kept = JSON.parse(String(rows[0]?.tool_result)) as unknown[];
    expect(kept).toHaveLength(72);
  });

  it("AC-031.3: the card offers the 'How Gemma decided' facts, from the stored decision", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "windows-wait-rain");
    expect(card.advice?.decision).toMatchObject({
      job: "advisor",
      prompt_version: "advisor.v1",
      tool_mode: "called",
      retries: 0,
    });
    expect(card.advice?.decision?.forecast).toHaveLength(6);
  });

  it("AC-031.3: a restart while Gemma was thinking leaves a card with Retry and the advice it had", async () => {
    const h = await setup();
    const { card } = await capture(h, "advice-windows", "windows-wait-rain");
    h.db
      .prepare("UPDATE cards SET gemma_state = 'offline', gemma_failure = 'restart' WHERE id = ?")
      .run(card.id);
    const after = (await h.get(`/api/cards/${card.id}`)).json<AdviceCard>();
    expect(after.advice?.can_retry).toBe(true);
  });
});
