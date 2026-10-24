import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ANSWER_WINDOW_MS } from "../src/domain/settlement.js";
import { judgeScenarioFromAnswer } from "../src/server/fakes.js";
import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { CappedModelClient } from "../src/server/model/capped.js";
import type { ChatRequest } from "../src/server/model/client.js";
import { FakeModelClient } from "../src/server/model/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { FakeClock, LOCAL_ORIGIN } from "./helpers.js";
import { multipartBody, syntheticPhoto } from "./support/photos.js";
import { HOUR, MINUTE, seedBet, settlementOf, statusOf, tap } from "./support/settle.js";

/*
 * AC-032.4, AC-032.5: a bet whose after photo was saved before vision was switched off (or in a
 * data folder moved from home mode) must not retry a refused call for ever, and must not use up
 * the daily cap while it waits.
 */

/** The fake model behind the hosted client: it refuses images the way `DigitalOceanClient` does. */
class VisionOffModel extends FakeModelClient {
  chats = 0;
  refuses(request: ChatRequest): string | undefined {
    return request.images === undefined || request.images.length === 0
      ? undefined
      : "photos are not sent to DigitalOcean (SIB_DO_VISION is 0)";
  }
  override async chat(request: ChatRequest) {
    this.chats += 1;
    return super.chat(request);
  }
}

let dir: string;
let harness: CoreHarness | undefined;
let capDb: Db | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  capDb?.close();
  capDb = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A bet with a saved photo answer that waits for Gemma, made while photos were on. */
async function betWaitingWithPhoto(clock: FakeClock): Promise<number> {
  dir = mkdtempSync(join(tmpdir(), "sib-photo-bets-"));
  const options = { dbPath: join(dir, "sib.db"), photosDir: join(dir, "photos"), clock };
  const first = await createCoreHarness(options);
  await pair(first);
  const betId = seedBet(first, { settleOffsetMs: -2 * HOUR });
  first.model.setScenario("judge", "offline");
  const body = multipartBody(await syntheticPhoto());
  const sent = await first.request({
    method: "POST",
    url: `/api/bets/${betId}/settle`,
    payload: body.payload,
    headers: { cookie: first.cookie, origin: LOCAL_ORIGIN, ...body.headers },
  });
  expect(sent.statusCode).toBe(202);
  expect(first.db.prepare("SELECT evidence FROM settle_progress").get()).toEqual({
    evidence: "photo",
  });
  first.db
    .prepare("UPDATE cards SET photo_state = 'inspecting' WHERE id = (SELECT card_id FROM bets)")
    .run();
  await first.close();
  return betId;
}

/** The same data folder, started the hosted way with vision off and the cap around the model. */
async function restartHostedVisionOff(clock: FakeClock): Promise<{
  inner: VisionOffModel;
}> {
  const inner = new VisionOffModel({ scenario: judgeScenarioFromAnswer });
  capDb = openDatabase(join(dir, "sib.db"));
  migrate(capDb, MIGRATIONS);
  const capped = new CappedModelClient(inner, { db: capDb, now: clock.now, cap: 10 });
  harness = await createCoreHarness({
    dbPath: join(dir, "sib.db"),
    photosDir: join(dir, "photos"),
    clock,
    model: capped as unknown as FakeModelClient,
    deployment: { mode: "hosted", photos: false },
  });
  await pair(harness);
  return { inner };
}

const callsToday = (): unknown => capDb?.prepare("SELECT COUNT(*) AS n FROM model_calls").get();

describe("AC-032.4, AC-032.5: a saved photo answer with vision off", () => {
  it("sets the photo answer aside, calls no model, counts nothing and asks for a tap", async () => {
    const clock = new FakeClock();
    const betId = await betWaitingWithPhoto(clock);
    const { inner } = await restartHostedVisionOff(clock);
    const h = harness!;

    for (let pass = 0; pass < 5; pass += 1) {
      clock.advance(3 * MINUTE); // past the two-minute back-off, five scheduler passes
      await h.core.scheduler.tickSettlement();
    }
    expect(inner.chats).toBe(0);
    expect(callsToday()).toEqual({ n: 0 });
    // The bet is back to "answer needed"; the photo stays on the server, unused.
    expect(h.db.prepare("SELECT evidence, photo_id FROM settle_progress").get()).toEqual({
      evidence: null,
      photo_id: null,
    });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM photos WHERE role = 'after'").get()).toEqual({
      n: 1,
    });
    const slips = (await h.get("/api/slips")).json<{
      settle_now: { id: number; settle: { state: string } }[];
    }>();
    expect(slips.settle_now.find((bet) => bet.id === betId)?.settle.state).toBe("answer_needed");
    expect(statusOf(h, betId)).not.toBe("settled");

    // One tap settles it, at half points.
    expect(await tap(h, betId, "moist")).toMatchObject({ status: 200 });
    expect(settlementOf(h, betId)).toMatchObject({ evidence: "tap", multiplier: 0.5 });
  });

  it("24 h after the settle time the judge decides on the recorded weather, at half points", async () => {
    const clock = new FakeClock();
    const betId = await betWaitingWithPhoto(clock);
    const { inner } = await restartHostedVisionOff(clock);
    const h = harness!;
    clock.advance(ANSWER_WINDOW_MS);
    await h.core.scheduler.tickSettlement();
    expect(settlementOf(h, betId)).toMatchObject({ evidence: "auto", multiplier: 0.5 });
    // Only the verdict used a call, and it carried no image.
    expect(inner.chats).toBe(1);
    expect(callsToday()).toEqual({ n: 1 });
  });

  it("does not leave a card 'inspecting' at start, and starts no inspection", async () => {
    const clock = new FakeClock();
    await betWaitingWithPhoto(clock);
    const { inner } = await restartHostedVisionOff(clock);
    expect(harness!.db.prepare("SELECT photo_state, photo_failure FROM cards").get()).toEqual({
      photo_state: "failed",
      photo_failure: "restart",
    });
    expect(inner.chats).toBe(0);
  });
});
