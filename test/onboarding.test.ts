import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSnapshot } from "../src/domain/savings.js";
import { CONFIG_DIR } from "../src/server/config.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { EXAMPLE_HOUSEHOLD, createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";

// Synthetic answers only: nothing here is a real household value.
const ANSWERS = {
  outdoorItems: ["balcony_plants", "clothes_line"],
  dryer: "vented",
  airConditioning: true,
  heaterThisSeason: false,
  location: { latitude: 40.4168, longitude: -3.7038 },
} as const;

interface OnboardingView {
  state: "pending" | "completed" | "skipped";
  household: typeof ANSWERS;
}

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
  harness = await createCoreHarness({ weatherProfile: FAKE_WEATHER_PROFILES.breezy, ...options });
  opened = true;
  await pair(harness);
  // Inside the line-dry offer window (10:00 Madrid).
  harness.clock.current = Date.UTC(2026, 9, 22, 8, 0);
}

const put = (body: unknown) =>
  harness.request({
    method: "PUT",
    url: "/api/onboarding",
    payload: body as Record<string, unknown>,
    headers: { cookie: harness.cookie, origin: "http://localhost:8787" },
  });
const view = async (): Promise<OnboardingView> =>
  (await harness.get("/api/onboarding")).json<OnboardingView>();

/** Places a do-nothing bet on a line-dry card and returns the snapshot written on it. */
async function lineDryBet(): Promise<{ id: number; dryerText: string }> {
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
  return { id: bet.id, dryerText: parseSnapshot(text)!.assumption };
}

describe("migration 0013: household_profile", () => {
  it("is number 13 (11 is rescue, 12 belongs to appeals) and keeps at most one coherent row", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toContain(13);
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    const insert = db.prepare(
      "INSERT INTO household_profile (id, status, profile, updated_at) VALUES (?, ?, ?, 1)",
    );
    expect(() => insert.run(2, "skipped", null)).toThrow();
    expect(() => insert.run(1, "completed", null)).toThrow();
    expect(() => insert.run(1, "skipped", "{}")).toThrow();
    expect(() => insert.run(1, "maybe", null)).toThrow();
    insert.run(1, "skipped", null);
    expect(() => insert.run(1, "skipped", null)).toThrow();
    db.close();
  });
});

describe("AC-029.2: with the onboarding flag off nothing changes", () => {
  it("has no onboarding routes, and the config baseline is the household", async () => {
    await setup({ household: { ...EXAMPLE_HOUSEHOLD, dryer: "condenser" } });
    expect((await harness.get("/api/onboarding")).statusCode).toBe(404);
    expect((await put(ANSWERS)).statusCode).toBe(404);
    expect((await harness.post("/api/onboarding/skip", {})).statusCode).toBe(404);
    expect((await lineDryBet()).dryerText).toContain("condenser");
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM household_profile").get()).toEqual({
      n: 0,
    });
  });
});

describe("AC-024.1: the first open asks for outdoor items, dryer, AC and heater, and location", () => {
  it("starts as pending with the baseline and the default location filled in", async () => {
    await setup({ flags: { onboarding: true } });
    expect(await view()).toEqual({
      state: "pending",
      household: {
        airConditioning: false,
        heaterThisSeason: false,
        dryer: "heat-pump",
        location: { latitude: 41.4, longitude: 2.16 },
      },
    });
  });

  it("stores the answers, rounds the location to 2 decimals and shows them afterwards", async () => {
    await setup({ flags: { onboarding: true } });
    const saved = await put(ANSWERS);
    expect(saved.statusCode).toBe(200);
    expect(await view()).toEqual({
      state: "completed",
      household: { ...ANSWERS, location: { latitude: 40.42, longitude: -3.7 } },
    });
    // The answers can be changed later.
    expect((await put({ ...ANSWERS, dryer: "none" })).statusCode).toBe(200);
    expect((await view()).household.dryer).toBe("none");
  });

  it.each([
    ["a missing question", { ...ANSWERS, dryer: undefined }],
    ["an unknown dryer", { ...ANSWERS, dryer: "tumble" }],
    ["an unknown outdoor item", { ...ANSWERS, outdoorItems: ["garden"] }],
    ["a latitude out of range", { ...ANSWERS, location: { latitude: 95, longitude: 2 } }],
    ["an extra key", { ...ANSWERS, name: "somebody" }],
    ["no location", { ...ANSWERS, location: undefined }],
  ])("refuses %s with 400 and stores nothing", async (_label, body) => {
    await setup({ flags: { onboarding: true } });
    expect((await put(body)).statusCode).toBe(400);
    expect((await view()).state).toBe("pending");
  });

  it("keeps the answers in the database only: no config file is written", async () => {
    const real = `${CONFIG_DIR}household.json`;
    const hadReal = existsSync(real);
    const example = readFileSync(`${CONFIG_DIR}household.example.json`, "utf8");
    await setup({ flags: { onboarding: true } });
    await put(ANSWERS);
    expect(existsSync(real)).toBe(hadReal);
    expect(readFileSync(`${CONFIG_DIR}household.example.json`, "utf8")).toBe(example);
    expect(harness.db.prepare("SELECT status FROM household_profile").all()).toEqual([
      { status: "completed" },
    ]);
  });

  it("survives a restart on the same database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sib-onboarding-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const dbPath = join(dir, "sib.db");
    await setup({ flags: { onboarding: true }, dbPath });
    await put(ANSWERS);
    await harness.close();
    opened = false;
    harness = await createCoreHarness({ flags: { onboarding: true }, dbPath });
    opened = true;
    await pair(harness);
    expect((await view()).state).toBe("completed");
  });
});

describe("AC-024.2: skipped or unanswered onboarding uses the baseline in the config file", () => {
  it("uses the baseline while onboarding is pending and after a skip", async () => {
    await setup({
      flags: { onboarding: true },
      household: { ...EXAMPLE_HOUSEHOLD, dryer: "condenser" },
    });
    expect((await lineDryBet()).dryerText).toContain("condenser");
    const skipped = await harness.post("/api/onboarding/skip", {});
    expect(skipped.json<OnboardingView>().state).toBe("skipped");
    expect((await view()).household.dryer).toBe("condenser");
    expect((await lineDryBet()).dryerText).toContain("condenser");
  });

  it("refuses a second skip, and a skip after the answers, with 409", async () => {
    await setup({ flags: { onboarding: true } });
    expect((await harness.post("/api/onboarding/skip", {})).statusCode).toBe(200);
    expect((await harness.post("/api/onboarding/skip", {})).statusCode).toBe(409);
    await put(ANSWERS);
    expect((await harness.post("/api/onboarding/skip", {})).statusCode).toBe(409);
    expect((await view()).state).toBe("completed");
  });
});

describe("the habit baseline feeds savings and seasonal chores (REQ-024, REQ-011, AC-016.5)", () => {
  it("AC-011.1: a bet placed after onboarding uses the answers; a bet placed before keeps its figure", async () => {
    await setup({ flags: { onboarding: true } });
    const before = await lineDryBet();
    expect(before.dryerText).toContain("heat-pump");
    await put({ ...ANSWERS, dryer: "vented" });
    const after = await lineDryBet();
    expect(after.dryerText).toContain("vented");
    const stored = (id: number) =>
      harness.db
        .prepare<[number], { savings_snapshot: string }>(
          "SELECT savings_snapshot FROM bets WHERE id = ?",
        )
        .get(id)!.savings_snapshot;
    expect(parseSnapshot(stored(before.id))!.assumption).toContain("heat-pump");
    // The snapshot is write-once, so a changed baseline cannot rewrite it either.
    expect(() =>
      harness.db.prepare("UPDATE bets SET savings_snapshot = '{}' WHERE id = ?").run(before.id),
    ).toThrow(/cannot be updated/);
  });

  it("AC-016.5: AC and heater cards follow the answers, not the config", async () => {
    await setup({ flags: { onboarding: true, heater: true } });
    const quick = async (chore: string) =>
      (await harness.post("/api/cards/quick", { chore_type: chore })).json<{
        notice: string | null;
      }>();
    expect((await quick("ac")).notice).toBe("Not needed this season");
    await put({ ...ANSWERS, airConditioning: true, heaterThisSeason: false });
    expect((await quick("ac")).notice).not.toBe("Not needed this season");
    expect((await quick("heater")).notice).toBe("Not needed this season");
  });
});
