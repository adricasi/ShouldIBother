import { readdirSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ANSWER_WINDOW_MS } from "../src/domain/settlement.js";
import { Appealer } from "../src/server/ledger/appeal.js";
import { buildExport } from "../src/server/ledger/export.js";
import { deleteBetData } from "../src/server/ledger/photos.js";
import { pointsTotal } from "../src/server/ledger/points.js";
import type { Receipt } from "../src/server/ledger/receipt.js";
import type { Score } from "../src/server/ledger/score.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";
import { receiptSchema, slipsSchema } from "../src/web/api.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { LOCAL_ORIGIN } from "./helpers.js";
import { multipartBody, syntheticPhoto } from "./support/photos.js";
import { HOUR, judgeCalls, makeSettler, seedBet, tap } from "./support/settle.js";

let harness: CoreHarness;
afterEach(async () => {
  await harness.close();
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<void> {
  harness = await createCoreHarness({
    flags: { appeals: true },
    weatherProfile: FAKE_WEATHER_PROFILES.rainy,
    ...options,
  });
  await pair(harness);
}

interface AppealBody {
  state?: string;
  receipt?: Receipt;
  title?: string;
}

async function appeal(
  betId: number,
  bytes?: Buffer,
): Promise<{ status: number; body: AppealBody }> {
  const body = multipartBody(bytes ?? (await syntheticPhoto({ shade: 140 })));
  const response = await harness.request({
    method: "POST",
    url: `/api/bets/${betId}/appeal`,
    payload: body.payload,
    headers: { cookie: harness.cookie, origin: LOCAL_ORIGIN, ...body.headers },
  });
  return { status: response.statusCode, body: response.json<AppealBody>() };
}

interface SettlementRows {
  id: number;
  verdict: string;
  points: number;
  final: number;
  appeal_of: number | null;
  evidence: string;
  multiplier: number;
  multiplier_capped: number;
  decision_id: number | null;
}

const settlementsOf = (betId: number): SettlementRows[] =>
  harness.db
    .prepare<[number], SettlementRows>("SELECT * FROM settlements WHERE bet_id = ? ORDER BY id")
    .all(betId);

const photoFiles = (): string[] =>
  readdirSync(harness.photos.dir).filter((name) => name.endsWith(".jpg") || name.endsWith(".tmp"));

/** A bet settled on a dry tap: a normal loss of -50 at odds 70, ready to be appealed. */
async function lostBet(): Promise<number> {
  const betId = seedBet(harness, { band: 3 });
  const settled = await tap(harness, betId, "dry");
  expect(settled.body.receipt).toMatchObject({ verdict: "normal_loss", points: -50 });
  return betId;
}

describe("REQ-023: appeal a verdict", () => {
  it("AC-029.2: with the appeals flag off there is no route, and receipts are what they were", async () => {
    await setup({ flags: {} });
    const betId = await lostBet();
    expect((await appeal(betId)).status).toBe(404);
    const receipt = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(receipt).not.toHaveProperty("can_appeal");
    expect(receipt).not.toHaveProperty("appeal");
    expect(settlementsOf(betId)).toHaveLength(1);
  });

  it("AC-023.1: an appeal with a new photo re-judges the bet, replaces the points and marks the second verdict final", async () => {
    await setup();
    const betId = await lostBet();
    expect(pointsTotal({ db: harness.db })).toBe(-50);

    const { status, body } = await appeal(betId);
    expect(status).toBe(200);
    // The new verdict at the photo multiplier: (100 - 70) x 1.0.
    expect(body.receipt).toMatchObject({
      verdict: "win",
      points: 30,
      total_points: 30,
      multiplier: 1,
      evidence: { kind: "photo" },
      outcome: "paid_out",
      appeal: { first: { verdict: "normal_loss", points: -50 }, changed: true },
      can_appeal: false,
    });
    expect(body.receipt?.gemma_read?.reason).toContain("new photo");

    const rows = settlementsOf(betId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ verdict: "normal_loss", final: 0, appeal_of: null });
    expect(rows[1]).toMatchObject({
      verdict: "win",
      final: 1,
      appeal_of: rows[0]!.id,
      evidence: "photo",
      multiplier: 1,
      multiplier_capped: 0,
    });
    expect(rows[1]!.decision_id).not.toBeNull();
    // The total, the savings and Slips read the second verdict only.
    const today = (await harness.get("/api/today")).json<{
      points: { total: number };
      week: { totals: { wins: number } };
    }>();
    expect(today.points.total).toBe(30);
    expect(today.week.totals.wins).toBe(1);
    const slips = slipsSchema.parse((await harness.get("/api/slips")).json());
    expect(slips.settled).toHaveLength(1);
    expect(slips.settled[0]).toMatchObject({ result: { verdict: "win", points: 30 } });
    expect(slips.settled[0]!.receipt.appeal?.first.verdict).toBe("normal_loss");
  });

  it("AC-023.1: the appealed receipt and its Slips line keep the bet's chore_type", async () => {
    await setup();
    const betId = await lostBet();
    const { body } = await appeal(betId);
    expect(body.receipt).toMatchObject({ chore_type: "plants" });
    const slips = slipsSchema.parse((await harness.get("/api/slips")).json());
    expect(slips.settled.map((bet) => [bet.chore_type, bet.receipt.chore_type])).toEqual([
      ["plants", "plants"],
    ]);
    expect(
      receiptSchema.parse((await harness.get(`/api/bets/${betId}/receipt`)).json()),
    ).toMatchObject({ chore_type: "plants" });
  });

  it("AC-023.1: the judge gets the new photo, the first verdict and the stored weather, under the appeal prompt, and the photo is stored as an appeal photo", async () => {
    await setup();
    const betId = await lostBet();
    await appeal(betId);
    const calls = judgeCalls(harness);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      images: 1,
      data: {
        bet: "do_nothing",
        evidence: "after photo",
        photos: ["after"],
        can_ask: false,
        appeal: { first_verdict: "normal_loss", first_evidence: "one tap" },
      },
    });
    expect(calls[1]!.data["recorded_weather"]).not.toBeNull();
    const decisions = harness.db
      .prepare<[], { prompt_version: string; photo_id: string | null }>(
        "SELECT prompt_version, photo_id FROM gemma_decisions WHERE job = 'judge' ORDER BY id",
      )
      .all();
    expect(decisions.map((row) => row.prompt_version)).toEqual(["judge.v3", "judge-appeal.v2"]);
    const photos = harness.db
      .prepare<[number], { id: string; role: string }>(
        "SELECT id, role FROM photos WHERE bet_id = ?",
      )
      .all(betId);
    expect(photos).toEqual([{ id: decisions[1]!.photo_id, role: "appeal" }]);
  });

  it("AC-023.1: a loss that stays a loss on appeal replaces the points with the second loss", async () => {
    await setup();
    const betId = await lostBet();
    harness.model.setScenario("judge", "appeal-harmful-loss");
    const { body } = await appeal(betId);
    expect(body.receipt).toMatchObject({
      verdict: "harmful_loss",
      points: -150,
      total_points: -150,
      appeal: { changed: true },
    });
    expect(pointsTotal({ db: harness.db })).toBe(-150);
  });

  it("AC-023.2: a bet that was appealed is not offered another appeal, and a second request is refused", async () => {
    await setup();
    const betId = await lostBet();
    const before = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(before.can_appeal).toBe(true);
    expect((await appeal(betId)).status).toBe(200);

    const again = await appeal(betId);
    expect(again.status).toBe(409);
    const receipt = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(receiptSchema.parse(receipt).can_appeal).toBe(false);
    const slips = slipsSchema.parse((await harness.get("/api/slips")).json());
    expect(slips.settled[0]!.receipt.can_appeal).toBe(false);
    expect(settlementsOf(betId)).toHaveLength(2);
    expect(pointsTotal({ db: harness.db })).toBe(30);
    // The refused request stored nothing and called no judge.
    expect(judgeCalls(harness)).toHaveLength(2);
    expect(photoFiles()).toHaveLength(1);
  });

  it("AC-023.2: two appeals sent together decide one appeal", async () => {
    await setup();
    const betId = await lostBet();
    const [first, second] = await Promise.all([appeal(betId), appeal(betId)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(settlementsOf(betId)).toHaveLength(2);
    expect(settlementsOf(betId).filter((row) => row.final === 1)).toHaveLength(1);
  });

  it("AC-023.2: the database refuses a second appeal row and a second final row for a bet", async () => {
    await setup();
    const betId = await lostBet();
    await appeal(betId);
    const [original, second] = settlementsOf(betId);
    const insert = (appealOf: number | null, final: number): unknown =>
      harness.db
        .prepare(
          `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
           VALUES (?, 'photo', 1, 'win', 30, 1, ?, ?)`,
        )
        .run(betId, appealOf, final);
    expect(() => insert(original!.id, 0)).toThrow(/UNIQUE/);
    expect(() => insert(second!.id, 0)).toThrow(/UNIQUE|follow the original/);
    expect(() => insert(null, 1)).toThrow(/UNIQUE/);
  });

  it("AC-023.3: an appeal that changes the verdict counts as an overrule on Score, and one that confirms it does not", async () => {
    await setup({ flags: { appeals: true, score: true } });
    // Real-model verdicts: the fake model's are fixtures and are not in the judge's N.
    const realModel = (betId: number): void => {
      harness.db
        .prepare(
          `UPDATE gemma_decisions SET model = 'gemma4:e4b'
           WHERE id = (SELECT decision_id FROM settlements WHERE bet_id = ? AND appeal_of IS NULL)`,
        )
        .run(betId);
    };
    const score = async (): Promise<Score["judge"]> =>
      (await harness.get("/api/score")).json<Score>().judge;

    const overruled = await lostBet();
    realModel(overruled);
    const confirmed = await lostBet();
    realModel(confirmed);
    const untouched = await lostBet();
    realModel(untouched);
    expect(await score()).toEqual({ appeals: "on", n: 3, overruled: 0, rate_pct: 0 });

    expect((await appeal(overruled)).status).toBe(200);
    expect(await score()).toEqual({ appeals: "on", n: 3, overruled: 1, rate_pct: 33 });

    harness.model.setScenario("judge", "appeal-normal-loss");
    const same = await appeal(confirmed);
    expect(same.body.receipt).toMatchObject({ verdict: "normal_loss", appeal: { changed: false } });
    expect(await score()).toEqual({ appeals: "on", n: 3, overruled: 1, rate_pct: 33 });

    // The calibration and the total follow the final verdicts.
    const body = (await harness.get("/api/score")).json<Score>();
    expect(body.points.total).toBe(30 - 50 - 50);
    expect(body.calibration.settled).toBe(3);
    expect(body.calibration.rule[3]).toMatchObject({ n: 3, wins: 1 });
  });

  it("refuses an appeal on a bet that is not settled, a do-it decision, a cashed-out bet and an unknown bet", async () => {
    await setup();
    const open = seedBet(harness, { settleOffsetMs: HOUR, status: "open" });
    expect((await appeal(open)).status).toBe(409);
    const due = seedBet(harness);
    expect((await appeal(due)).status).toBe(409);
    const doIt = seedBet(harness, { kind: "do_it" });
    await harness.core.scheduler.tickSettlement();
    expect(settlementsOf(doIt)).toHaveLength(1);
    expect((await appeal(doIt)).status).toBe(409);
    const cashedOut = seedBet(harness, { status: "cashed_out" });
    expect((await appeal(cashedOut)).status).toBe(409);
    expect((await appeal(9999)).status).toBe(404);
    expect(judgeCalls(harness).length).toBeLessThanOrEqual(1);
    expect(photoFiles()).toEqual([]);
  });

  it("refuses a request that is not a photo, and an undecodable file, leaving the bet as it was", async () => {
    await setup();
    const betId = await lostBet();
    const json = await harness.post(`/api/bets/${betId}/appeal`, {});
    expect(json.statusCode).toBe(415);
    expect((await appeal(betId, Buffer.from("not a picture"))).status).toBe(415);
    expect(settlementsOf(betId)).toHaveLength(1);
    expect(photoFiles()).toEqual([]);
  });

  it("AC-023.1: when Gemma cannot answer nothing changes, the new photo is not kept, and the appeal can be sent again", async () => {
    await setup();
    const betId = await lostBet();
    harness.model.setScenario("judge", "offline");
    const failed = await appeal(betId);
    expect(failed.status).toBe(503);
    expect(settlementsOf(betId)).toEqual([expect.objectContaining({ final: 1, points: -50 })]);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });
    expect(photoFiles()).toEqual([]);
    const receipt = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(receipt.can_appeal).toBe(true);

    harness.model.setScenario("judge", "appeal-win");
    expect((await appeal(betId)).status).toBe(200);
    expect(pointsTotal({ db: harness.db })).toBe(30);
  });

  it("AC-023.1, AC-008.8: an appeal decided 24 h or more after the settle time pays a win at x0.5 and is flagged", async () => {
    await setup();
    const betId = await lostBet();
    harness.clock.advance(ANSWER_WINDOW_MS + HOUR);
    const { body } = await appeal(betId);
    expect(body.receipt).toMatchObject({
      verdict: "win",
      points: 15,
      multiplier: 0.5,
      multiplier_capped: true,
      evidence: { kind: "photo" },
    });
    expect(settlementsOf(betId)[1]).toMatchObject({ multiplier_capped: 1, points: 15, final: 1 });
  });

  it("AC-023.1: an appeal turns a won bet into a loss too, and its savings leave the totals", async () => {
    await setup();
    const betId = seedBet(harness, { band: 3 });
    expect((await tap(harness, betId, "moist")).body.receipt?.verdict).toBe("win");
    expect(
      (await harness.get("/api/today")).json<{ week: { totals: { wins: number } } }>().week.totals
        .wins,
    ).toBe(1);
    harness.model.setScenario("judge", "appeal-small-loss");
    const { body } = await appeal(betId);
    expect(body.receipt).toMatchObject({ verdict: "small_loss", points: -25, outcome: "loss" });
    const today = (await harness.get("/api/today")).json<{
      points: { total: number };
      week: { totals: { wins: number } };
    }>();
    expect(today.points.total).toBe(-25);
    expect(today.week.totals.wins).toBe(0);
  });

  it("the export shows both verdicts and the appeal photo", async () => {
    await setup();
    const betId = await lostBet();
    await appeal(betId);
    const exported = buildExport(harness.db, harness.clock.current);
    const verdicts = exported.verdicts.filter((row) => row.bet_id === betId);
    expect(verdicts).toEqual([
      expect.objectContaining({ verdict: "normal_loss", final: 0, appeal_of: null }),
      expect.objectContaining({ verdict: "win", final: 1, appeal_of: verdicts[0]!.id }),
    ]);
    expect(exported.photos.filter((photo) => photo.bet_id === betId)).toEqual([
      expect.objectContaining({ role: "appeal" }),
    ]);
    expect(exported.totals.points).toBe(30);
  });

  it("AC-015.2: deleting the appeal photo deletes the judge's second read; the verdict and points stay", async () => {
    await setup();
    const betId = await lostBet();
    await appeal(betId);
    const photo = harness.db
      .prepare<[number], { id: string }>("SELECT id FROM photos WHERE bet_id = ?")
      .get(betId)!;
    expect((await harness.delete(`/api/photos/${photo.id}`)).statusCode).toBe(204);
    const receipt = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(receipt).toMatchObject({ verdict: "win", points: 30, gemma_read: null });
    expect(settlementsOf(betId)).toHaveLength(2);
  });

  it("the start-up sweep drops an appeal photo whose appeal never finished", async () => {
    await setup();
    const betId = await lostBet();
    const body = multipartBody(await syntheticPhoto());
    expect(body).toBeDefined();
    harness.db
      .prepare(
        `INSERT INTO photos (id, card_id, bet_id, role, file, received_at, width, height)
         VALUES ('11111111-1111-4111-8111-111111111111', NULL, ?, 'appeal', 'x.jpg', 1, 1, 1)`,
      )
      .run(betId);
    const { sweepOrphanPhotos } = await import("../src/server/ledger/photos.js");
    sweepOrphanPhotos({ db: harness.db, photos: harness.photos });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });
  });
});

/** Runs `action` the first time the judge is asked about an appeal, before it answers. */
function onAppealJudgement(action: () => void): void {
  const chat = harness.model.chat.bind(harness.model);
  let done = false;
  vi.spyOn(harness.model, "chat").mockImplementation((request) => {
    const text = request.messages.map((message) => message.content).join("\n");
    if (!done && request.job === "judge" && text.includes('"appeal":{')) {
      done = true;
      action();
    }
    return chat(request);
  });
}

describe("REQ-023: the 24 h cap on appeals is visible", () => {
  it("AC-023.1, AC-008.8: the receipt says whether an appeal now pays at most half points", async () => {
    await setup();
    const betId = await lostBet();
    const fresh = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(fresh).toMatchObject({ can_appeal: true, appeal_pays_half: false });
    harness.clock.advance(ANSWER_WINDOW_MS + HOUR);
    const late = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(late).toMatchObject({ can_appeal: true, appeal_pays_half: true });
    const slips = slipsSchema.parse((await harness.get("/api/slips")).json());
    expect(slips.settled[0]!.receipt.appeal_pays_half).toBe(true);
  });

  it("AC-008.8, AC-023.1: a bet auto-settled after 24 h can be appealed, and the win pays at x0.5", async () => {
    await setup();
    const betId = seedBet(harness, { band: 3, settleOffsetMs: -(ANSWER_WINDOW_MS + HOUR) });
    harness.model.setScenario("judge", "normal-loss");
    await harness.core.scheduler.tickSettlement();
    expect(settlementsOf(betId)).toEqual([
      expect.objectContaining({
        evidence: "auto",
        verdict: "normal_loss",
        points: -50,
      }),
    ]);
    harness.model.setScenario("judge", "appeal-win");
    const { status, body } = await appeal(betId);
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({
      verdict: "win",
      points: 15,
      multiplier: 0.5,
      multiplier_capped: true,
      appeal_pays_half: true,
      appeal: { first: { verdict: "normal_loss", points: -50 }, changed: true },
    });
    expect(judgeCalls(harness)[1]!.data).toMatchObject({
      appeal: { first_evidence: "weather record only" },
    });
    expect(pointsTotal({ db: harness.db })).toBe(15);
  });
});

describe("REQ-023: refusals and failures leave the bet as it was", () => {
  it("a full Gemma queue answers 503 before the body is read: a broken upload is not buffered", async () => {
    await setup();
    const betId = await lostBet();
    vi.spyOn(harness.core.gemma, "full", "get").mockReturnValue(true);
    const response = await harness.request({
      method: "POST",
      url: `/api/bets/${betId}/appeal`,
      payload: "this is not a multipart body",
      headers: {
        cookie: harness.cookie,
        origin: LOCAL_ORIGIN,
        "content-type": "multipart/form-data; boundary=nothing",
      },
    });
    // Had the body been read first, the parser would have answered 400.
    expect(response.statusCode).toBe(503);
    expect(settlementsOf(betId)).toHaveLength(1);
    expect(photoFiles()).toEqual([]);
    expect(judgeCalls(harness)).toHaveLength(1);
  });

  it.each(["unsure", "invalid-json", "timeout"])(
    "AC-023.1: a judge answer of %s changes nothing and the appeal can be sent again",
    async (scenario) => {
      await setup();
      const betId = await lostBet();
      harness.model.setScenario("judge", scenario);
      expect((await appeal(betId)).status).toBe(503);
      expect(settlementsOf(betId)).toEqual([expect.objectContaining({ final: 1, points: -50 })]);
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });
      expect(photoFiles()).toEqual([]);
      expect(pointsTotal({ db: harness.db })).toBe(-50);
      expect((await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>().can_appeal).toBe(
        true,
      );
    },
  );

  it("the failed attempt is logged with ids only, because its decision row goes with the photo", async () => {
    const logLines: string[] = [];
    await setup({ logLines });
    const betId = await lostBet();
    harness.model.setScenario("judge", "invalid-json");
    await appeal(betId);
    const line = logLines.find((entry) => entry.includes("appeal-judge-failed"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({
      event: "appeal-judge-failed",
      bet_id: betId,
      failure: "invalid",
      decision_id: expect.any(Number) as unknown,
    });
  });

  it("the bet's data deleted during the judge call: the person sees the 409, not a 404 from the cleanup", async () => {
    const logLines: string[] = [];
    await setup({ logLines });
    const betId = await lostBet();
    // After the judge answered and before the verdict is committed: the lucky-win label reads weather.
    const getRecorded = harness.weather.getRecorded.bind(harness.weather);
    vi.spyOn(harness.weather, "getRecorded").mockImplementation((range) => {
      deleteBetData({ db: harness.db, photos: harness.photos }, betId);
      return getRecorded(range);
    });
    const { status } = await appeal(betId);
    expect(status).toBe(409);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 0 });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });
    expect(photoFiles()).toEqual([]);
    expect(logLines.some((entry) => entry.includes("appeal-photo-cleanup-failed"))).toBe(true);
  });

  it("a receipt that fails after the appeal was committed never deletes the appeal's photo or decision", async () => {
    await setup();
    const betId = await lostBet();
    const appealer = new Appealer(makeSettler(harness).deps, () => {
      throw new Error("receipt failed");
    });
    await expect(appealer.appeal(betId, await syntheticPhoto())).rejects.toThrow("receipt failed");
    const rows = settlementsOf(betId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ final: 1, verdict: "win" });
    const photo = harness.db
      .prepare<[number], { id: string }>("SELECT id FROM photos WHERE bet_id = ?")
      .get(betId);
    expect(photo).toBeDefined();
    expect(photoFiles()).toHaveLength(1);
    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM gemma_decisions WHERE id = ?")
        .get(rows[1]!.decision_id),
    ).toEqual({ n: 1 });
  });

  it("AC-023.2: an appeal row that got in first (another process) is refused with 409 by the unique index", async () => {
    await setup();
    const betId = await lostBet();
    const [original] = settlementsOf(betId);
    onAppealJudgement(() => {
      harness.db
        .prepare(
          `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
           VALUES (?, 'photo', 1, 'win', 30, 1, ?, 0)`,
        )
        .run(betId, original!.id);
    });
    const response = await appeal(betId);
    expect(response.status).toBe(409);
    // The flip of the first row was rolled back with the failed insert; the new photo went.
    expect(settlementsOf(betId).map((row) => row.final)).toEqual([1, 0]);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });
  });

  it("the receipt offers no appeal that would get a 409: a bet without an original settlement is not offered one", async () => {
    await setup();
    const betId = await lostBet();
    harness.db.prepare("DELETE FROM settlements WHERE bet_id = ?").run(betId);
    harness.db
      .prepare(
        `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
         VALUES (?, 'tap', 0.5, 'win', 15, 1, NULL, 1)`,
      )
      .run(betId);
    harness.db.prepare("UPDATE cards SET chore_type = 'unknown_chore'").run();
    const receipt = (await harness.get(`/api/bets/${betId}/receipt`)).json<Receipt>();
    expect(receipt.can_appeal).toBe(false);
    expect((await appeal(betId)).status).toBe(409);
  });
});
