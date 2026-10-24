import { afterEach, describe, expect, it } from "vitest";

import { MAX_PLACE_LABEL_CODE_POINTS, parsePlaceLabel } from "../src/domain/place-label.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { applyPlaceLabel } from "../src/server/household-store.js";
import { buildExport } from "../src/server/ledger/export.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { OpenMeteoWeatherClient } from "../src/server/weather/open-meteo-client.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { FakeClock } from "./helpers.js";
import { FakeOpenMeteo } from "./support/fake-open-meteo.js";
import { tap } from "./support/settle.js";

// A synthetic label that no real place and no prompt, URL or log line could contain by chance.
const LABEL = "Zyx Test Quarter · Nowhere";
const ANSWERS = {
  outdoorItems: ["balcony_plants"],
  dryer: "vented",
  airConditioning: false,
  heaterThisSeason: false,
  location: { latitude: 41.4, longitude: 2.16 },
};

describe("AC-026.3: the place label is trimmed, free of control characters and at most 40 code points", () => {
  it("accepts a plain label, trims it and treats blank as none", () => {
    expect(parsePlaceLabel("  Gràcia · Barcelona ")).toEqual({
      ok: true,
      label: "Gràcia · Barcelona",
    });
    expect(parsePlaceLabel("   ")).toEqual({ ok: true, label: null });
    expect(parsePlaceLabel(undefined)).toEqual({ ok: true, label: null });
    expect(parsePlaceLabel(null)).toEqual({ ok: true, label: null });
  });

  it("refuses control characters: newline, tab, escape and NUL", () => {
    for (const bad of ["Grà\ncia", "Grà\tcia", "Grà\u001bcia", "Grà\u0000cia", "a\u0085b"]) {
      expect(parsePlaceLabel(bad)).toMatchObject({ ok: false });
    }
  });

  it("refuses invisible format characters too: bidi overrides, zero-width space and joiner, the BOM", () => {
    for (const bad of [
      "Gr\u202eacia",
      "Gr\u200bacia",
      "Gr\u200dacia",
      "Gr\ufeffacia",
      "Gr\u2066acia",
    ]) {
      expect(parsePlaceLabel(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    // Ordinary punctuation, accents and the middle dot are fine.
    expect(parsePlaceLabel("Gràcia · Barcelona")).toMatchObject({ ok: true });
  });

  it("counts code points, not UTF-16 units: 40 emoji fit, 41 do not", () => {
    const emoji = "🌧";
    expect(emoji.length).toBe(2);
    expect(parsePlaceLabel(emoji.repeat(MAX_PLACE_LABEL_CODE_POINTS))).toMatchObject({ ok: true });
    expect(parsePlaceLabel(emoji.repeat(MAX_PLACE_LABEL_CODE_POINTS + 1))).toMatchObject({
      ok: false,
    });
    expect(parsePlaceLabel("a".repeat(40))).toMatchObject({ ok: true });
    expect(parsePlaceLabel("a".repeat(41))).toMatchObject({ ok: false });
  });
});

describe("migration 0015: household_profile.place_label", () => {
  it("is number 15 and applies to a seeded database without touching the rows it holds", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain(15);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const db = openDatabase(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.id <= 14),
    );
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
      INSERT INTO household_profile (id, status, profile, updated_at)
        VALUES (1, 'completed', '{"airConditioning":false,"heaterThisSeason":false,"dryer":"vented"}', 5);
    `);
    const before = db.prepare("SELECT * FROM household_profile").all();
    expect(migrate(db, MIGRATIONS)).toEqual(ids.filter((id) => id > 14));
    // The existing row is the same and the new column is null on it.
    expect(db.prepare("SELECT * FROM household_profile").all()).toEqual(
      before.map((row) => ({ ...(row as object), place_label: null })),
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 1 });
    // A second run changes nothing.
    expect(migrate(db, MIGRATIONS)).toEqual([]);
    db.close();
  });

  it("keeps 40 characters and refuses 41, as a backstop to the validator", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.exec(
      "INSERT INTO household_profile (id, status, profile, updated_at) VALUES (1, 'skipped', NULL, 1)",
    );
    const set = db.prepare("UPDATE household_profile SET place_label = ? WHERE id = 1");
    expect(() => set.run("a".repeat(40))).not.toThrow();
    expect(() => set.run("a".repeat(41))).toThrow();
    expect(() => set.run(null)).not.toThrow();
    db.close();
  });
});

describe("applyPlaceLabel: the hook the sample-data demo calls", () => {
  it("sets, clears and validates the label of the stored profile", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    // No profile row yet: there is nothing to attach the label to.
    expect(applyPlaceLabel(db, "Synthetic Quarter")).toBe(false);
    db.exec(
      "INSERT INTO household_profile (id, status, profile, updated_at) VALUES (1, 'skipped', NULL, 1)",
    );
    expect(applyPlaceLabel(db, "  Synthetic Quarter ")).toBe(true);
    expect(db.prepare("SELECT place_label FROM household_profile").get()).toEqual({
      place_label: "Synthetic Quarter",
    });
    expect(() => applyPlaceLabel(db, "bad\nlabel")).toThrow(/control/);
    expect(applyPlaceLabel(db, null)).toBe(true);
    expect(db.prepare("SELECT place_label FROM household_profile").get()).toEqual({
      place_label: null,
    });
    db.close();
  });
});

let harness: CoreHarness | undefined;
let server: FakeOpenMeteo | undefined;
afterEach(async () => {
  await harness?.close();
  await server?.stop();
  harness = undefined;
  server = undefined;
});

/** The app on the real Open-Meteo client and a fake HTTP server, the label saved in onboarding. */
async function setup(flags: Record<string, boolean>, logLines?: string[]): Promise<CoreHarness> {
  const clock = new FakeClock();
  clock.current = Date.UTC(2026, 9, 22, 8, 0);
  server = new FakeOpenMeteo(clock.now);
  await server.start();
  const transport = server.transport;
  harness = await createCoreHarness({
    clock,
    flags,
    ...(logLines === undefined ? {} : { logLines }),
    liveWeather: (db, now) =>
      new OpenMeteoWeatherClient({
        db,
        now,
        location: { latitude: 41.4, longitude: 2.16 },
        fetch: transport,
        sleep: () => Promise.resolve(),
        random: () => 0,
      }),
  });
  await pair(harness);
  return harness;
}

const put = (h: CoreHarness, body: Record<string, unknown>) =>
  h.request({
    method: "PUT",
    url: "/api/onboarding",
    payload: body,
    headers: { cookie: h.cookie, origin: "http://localhost:8787" },
  });

describe("AC-024.1: the place label is asked next to the location, and refused when it is not valid", () => {
  it("stores it, shows it again, and keeps it out of the household answers", async () => {
    const h = await setup({ onboarding: true });
    expect((await h.get("/api/onboarding")).json()).not.toHaveProperty("place_label");
    const saved = await put(h, { ...ANSWERS, place_label: `  ${LABEL}  ` });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ state: "completed", place_label: LABEL });
    expect((await h.get("/api/onboarding")).json()).toMatchObject({ place_label: LABEL });
    // The household JSON the savings, the weather location and the prompts read has no label.
    const stored = h.db.prepare("SELECT profile FROM household_profile").get() as {
      profile: string;
    };
    expect(stored.profile).not.toContain("Zyx");
    expect(Object.keys(JSON.parse(stored.profile) as object)).not.toContain("place_label");
  });

  it("clears it when blank or absent, and refuses control characters and 41 code points with a 400", async () => {
    const h = await setup({ onboarding: true });
    await put(h, { ...ANSWERS, place_label: LABEL });
    expect((await put(h, { ...ANSWERS, place_label: "   " })).json()).not.toHaveProperty(
      "place_label",
    );
    await put(h, { ...ANSWERS, place_label: LABEL });
    expect((await put(h, ANSWERS)).json()).not.toHaveProperty("place_label");
    for (const bad of ["a\nb", "x".repeat(41), "🌧".repeat(41)]) {
      const refused = await put(h, { ...ANSWERS, place_label: bad });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toContain("place_label");
    }
    // A refused answer changed nothing.
    expect((await h.get("/api/onboarding")).json()).not.toHaveProperty("place_label");
  });

  it("a null place_label clears it, like a blank one", async () => {
    const h = await setup({ onboarding: true });
    await put(h, { ...ANSWERS, place_label: LABEL });
    const cleared = await put(h, { ...ANSWERS, place_label: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).not.toHaveProperty("place_label");
    expect(h.db.prepare("SELECT place_label FROM household_profile").get()).toEqual({
      place_label: null,
    });
  });

  it("skipping onboarding leaves no label", async () => {
    const h = await setup({ onboarding: true });
    await h.post("/api/onboarding/skip", {});
    expect((await h.get("/api/onboarding")).json()).toMatchObject({ state: "skipped" });
    expect((await h.get("/api/onboarding")).json()).not.toHaveProperty("place_label");
  });
});

describe("AC-026.3: the label is in the weather board header only while onboarding and splitFlap are on", () => {
  async function boardOf(h: CoreHarness): Promise<Record<string, unknown> | null | undefined> {
    // A card prices a forecast, which the board then reads from the cache.
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    return (await h.get("/api/today")).json<{ weather_board?: Record<string, unknown> | null }>()
      .weather_board;
  }

  it("shows it with both flags on, and not once it is cleared", async () => {
    const h = await setup({ onboarding: true, splitFlap: true });
    await put(h, { ...ANSWERS, place_label: LABEL });
    expect(await boardOf(h)).toMatchObject({ place_label: LABEL });
    await put(h, { ...ANSWERS, place_label: "" });
    const today = (await h.get("/api/today")).json<{ weather_board: object }>();
    expect(today.weather_board).not.toHaveProperty("place_label");
  });

  it("is not on the board without the splitFlap flag: there is no board", async () => {
    const h = await setup({ onboarding: true });
    await put(h, { ...ANSWERS, place_label: LABEL });
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    const today = (await h.get("/api/today")).json<{ weather_board?: unknown }>();
    expect(today).not.toHaveProperty("weather_board");
    expect(JSON.stringify(today)).not.toContain("Zyx");
  });

  it("is not on the board without the onboarding flag, even if a label sits in the database", async () => {
    const h = await setup({ splitFlap: true });
    h.db.exec(
      "INSERT INTO household_profile (id, status, profile, place_label, updated_at) VALUES (1, 'skipped', NULL, 'Zyx Test Quarter', 1)",
    );
    const board = await boardOf(h);
    expect(board).not.toBeNull();
    expect(board).not.toHaveProperty("place_label");
  });
});

describe("AC-026.3: the label never leaves the household screen and the board", () => {
  it("is in no Open-Meteo request, no Gemma prompt, no decision row, no log line and no card, quote or bet row", async () => {
    const logLines: string[] = [];
    const h = await setup({ onboarding: true, splitFlap: true, safetyGuard: true }, logLines);
    h.model.setScenario("bookmaker", "ok");
    await put(h, { ...ANSWERS, place_label: LABEL });
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.post("/api/cards/quick", { chore_type: "laundry_line" });
    // The guard and the bookmaker run one after the other: wait for both rounds.
    await h.idle();
    await h.idle();
    // Gemma's odds replaced the rule odds: bet on the quote the card shows now.
    const plants = (await h.get("/api/today"))
      .json<{ cards: { id: number; chore_type: string; quote: { id: number } }[] }>()
      .cards.find((card) => card.chore_type === "plants")!;
    const placed = await h.post("/api/bets", {
      card_id: plants.id,
      quote_id: plants.quote.id,
      kind: "do_nothing",
    });
    expect(placed.statusCode, placed.body).toBe(201);
    // The night goes by and the bet is settled by a tap: the judge runs too.
    const waiting = (await h.get("/api/slips")).json<{
      waiting: { id: number; settle_at: string }[];
    }>();
    h.clock.current = Date.parse(waiting.waiting[0]!.settle_at) + 3_600_000;
    await h.get("/api/today");
    await tap(h, waiting.waiting[0]!.id, "moist");
    await h.idle();
    await h.get("/api/slips");
    // The safety guard and the judge are among the prompts checked, not only the bookmaker's.
    const jobs = new Set(h.model.calls.map((call) => call.job));
    expect(jobs).toContain("safety");
    expect(jobs).toContain("judge");

    // Open-Meteo: every URL the real client built, decoded and raw.
    expect(server!.requests.length).toBeGreaterThan(0);
    for (const url of server!.requests) {
      expect(decodeURIComponent(url.href)).not.toContain("Zyx");
      expect(url.href).not.toContain("Zyx");
    }
    // Gemma: every message of every call, and every decision stored for it.
    expect(h.model.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.model.calls)).not.toContain("Zyx");
    const decisions = h.db.prepare("SELECT * FROM gemma_decisions").all();
    expect(decisions.length).toBeGreaterThan(0);
    expect(JSON.stringify(decisions)).not.toContain("Zyx");
    // The log, and the rows of the cards, quotes and bets.
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("")).not.toContain("Zyx");
    for (const table of ["cards", "quotes", "bets"]) {
      expect(JSON.stringify(h.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain("Zyx");
    }
  });

  it("is in sib export, in the household profile and nowhere else", async () => {
    const h = await setup({ onboarding: true, splitFlap: true });
    await put(h, { ...ANSWERS, place_label: LABEL });
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    const exported = buildExport(h.db, h.clock.now());
    expect(exported.household_profile).toMatchObject({ place_label: LABEL });
    // One occurrence only: the profile's own field.
    expect(JSON.stringify(exported).split("Zyx")).toHaveLength(2);
  });
});
