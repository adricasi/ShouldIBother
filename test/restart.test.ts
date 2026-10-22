import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { FakeClock } from "./helpers.js";

const MINUTE = 60_000;

let dir: string;
let running: CoreHarness | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(dir, { recursive: true, force: true });
});

interface Today {
  open_bets: { id: number; odds: number; settle_at: string }[];
  due_bets: { id: number }[];
  points: { total: number };
}

describe("NFR-003: an open bet survives a server restart and settles", () => {
  it("keeps the bet, its locked odds and its settle time on the same database file", async () => {
    dir = mkdtempSync(join(tmpdir(), "sib-restart-"));
    const dbPath = join(dir, "should-i-bother.db");
    const clock = new FakeClock();

    // First server: place a bet, then stop it.
    const first = await createCoreHarness({
      dbPath,
      clock,
      weatherProfile: FAKE_WEATHER_PROFILES.rainy,
    });
    await pair(first);
    const card = (await first.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
      quote: { id: number };
    }>();
    const bet = (
      await first.post("/api/bets", {
        card_id: card.id,
        quote_id: card.quote.id,
        kind: "do_nothing",
      })
    ).json<{
      id: number;
      odds: number;
      settle_at: string;
    }>();
    const cookie = first.cookie;
    await first.close();

    // The laptop is off past the settle time; a new app instance opens the same file.
    clock.current = Date.parse(bet.settle_at) + 90 * MINUTE;
    running = await createCoreHarness({ dbPath, clock });
    running.cookie = cookie; // the paired phone's session lives in the database too

    // The bet is in the file exactly as placed, still open: nothing has moved it yet.
    expect(running.db.prepare("SELECT id, odds, status, settle_at FROM bets").all()).toEqual([
      { id: bet.id, odds: bet.odds, status: "open", settle_at: Date.parse(bet.settle_at) },
    ]);

    // The scheduler's first pass after the restart marks it due (Today would too, at read time).
    running.core.scheduler.tick();
    expect((await running.get("/api/today")).json<Today>().due_bets.map((b) => b.id)).toEqual([
      bet.id,
    ]);
    const settled = await running.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toMatchObject({ verdict: "win", points: 15 });
    expect((await running.get("/api/today")).json<Today>().points.total).toBe(15);
  });

  it("marks due the bets whose settle time passed while the server was down, on start", async () => {
    dir = mkdtempSync(join(tmpdir(), "sib-restart-"));
    const dbPath = join(dir, "should-i-bother.db");
    const clock = new FakeClock();
    const first = await createCoreHarness({ dbPath, clock });
    await pair(first);
    const card = (await first.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
      quote: { id: number };
    }>();
    const bet = (
      await first.post("/api/bets", {
        card_id: card.id,
        quote_id: card.quote.id,
        kind: "do_nothing",
      })
    ).json<{
      settle_at: string;
    }>();
    await first.close();

    clock.current = Date.parse(bet.settle_at) + MINUTE;
    running = await createCoreHarness({ dbPath, clock });
    running.core.scheduler.start(); // `start` runs one pass at once
    running.core.scheduler.stop();
    expect(running.db.prepare("SELECT status FROM bets").all()).toEqual([{ status: "due" }]);
  });
});
