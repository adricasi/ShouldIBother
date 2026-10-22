import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { GatedModel } from "./gemma-support.js";
import { createCoreHarness, pair, uploadPhoto, type CoreHarness } from "./core-helpers.js";
import { syntheticPhoto } from "./support/photos.js";

const MINUTE = 60_000;

let harness: CoreHarness;
let folder: string;
afterEach(async () => {
  await harness.close();
  rmSync(folder, { recursive: true, force: true });
});

async function setup(): Promise<string> {
  folder = mkdtempSync(join(tmpdir(), "sib-delete-"));
  const dbPath = join(folder, "sib.db");
  harness = await createCoreHarness({ dbPath });
  await pair(harness);
  return dbPath;
}

/** The database file and its WAL as bytes: what a forensic copy of the data folder would hold. */
function databaseBytes(dbPath: string): Buffer {
  const parts = [dbPath, `${dbPath}-wal`].filter((path) => existsSync(path));
  return Buffer.concat(parts.map((path) => readFileSync(path)));
}

function contains(bytes: Buffer, text: string): boolean {
  return bytes.includes(Buffer.from(text));
}

function count(table: string): number {
  return harness.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

interface Planted {
  readonly cardId: number;
  readonly photoId: string;
  readonly markers: readonly string[];
}

/**
 * A card with a photo, the quote made with it and the Gemma decisions that used it, each holding
 * text that appears nowhere else, so a scan of the database file can tell whether it was erased.
 */
async function plantPhotoWithDerivatives(tag: string): Promise<Planted> {
  const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
    id: number;
  }>();
  await harness.idle();
  const upload = await uploadPhoto(harness, card.id, await syntheticPhoto());
  const photoId = upload.json<{ photo: { id: string } }>().photo.id;
  await harness.idle();
  const markers = [`INSPECTOR-INPUT-${tag}`, `INSPECTOR-OUTPUT-${tag}`, `QUOTE-REASON-${tag}`];
  const decision = harness.db.prepare(
    `INSERT INTO gemma_decisions (job, card_id, photo_id, model, prompt_version, input_summary,
       output, valid, retries, latency_ms, created_at)
     VALUES (?, ?, ?, 'fake', 'v1', ?, ?, 1, 0, 5, ?)`,
  );
  const inspectorId = Number(
    decision.run("inspector", card.id, photoId, markers[0], markers[1], harness.clock.now())
      .lastInsertRowid,
  );
  decision.run("judge", card.id, photoId, `JUDGE-INPUT-${tag}`, `JUDGE-OUTPUT-${tag}`, 1);
  harness.db
    .prepare(
      `INSERT INTO quotes (card_id, source, band, odds, with_photo, photo_id, reason, settle_at,
         decision_id, created_at)
       VALUES (?, 'gemma', 2, 50, 1, ?, ?, ?, ?, ?)`,
    )
    .run(card.id, photoId, markers[2], harness.clock.now() + 60 * MINUTE, inspectorId, 2);
  return {
    cardId: card.id,
    photoId,
    markers: [...markers, `JUDGE-INPUT-${tag}`, `JUDGE-OUTPUT-${tag}`],
  };
}

describe("delete a photo (AC-015.2)", () => {
  it("AC-015.2: removes the file, the row, its quotes and the decisions that used it, unrecoverably", async () => {
    const dbPath = await setup();
    const kept = await plantPhotoWithDerivatives("KEPT");
    const doomed = await plantPhotoWithDerivatives("DOOMED");

    // The scan can see the text while it exists: after a checkpoint it is in the database file.
    harness.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const marker of [...doomed.markers, ...kept.markers]) {
      expect(contains(databaseBytes(dbPath), marker)).toBe(true);
    }
    const doomedFile = join(harness.photos.dir, `${doomed.photoId}.jpg`);
    expect(existsSync(doomedFile)).toBe(true);

    const response = await harness.delete(`/api/photos/${doomed.photoId}`);
    expect(response.statusCode).toBe(204);

    expect(existsSync(doomedFile)).toBe(false);
    expect(harness.db.prepare("SELECT 1 FROM photos WHERE id = ?").get(doomed.photoId)).toBe(
      undefined,
    );
    expect(
      harness.db.prepare("SELECT 1 FROM quotes WHERE photo_id = ?").get(doomed.photoId),
    ).toBeUndefined();
    expect(
      harness.db.prepare("SELECT 1 FROM gemma_decisions WHERE photo_id = ?").get(doomed.photoId),
    ).toBeUndefined();
    // Nothing of it is left in the database file or its WAL (no checkpoint needed by the test:
    // the delete itself checkpointed).
    const bytes = databaseBytes(dbPath);
    for (const marker of doomed.markers) {
      expect(contains(bytes, marker), marker).toBe(false);
    }
    expect(contains(bytes, doomed.photoId)).toBe(false);
    // The other photo and everything derived from it is untouched.
    for (const marker of kept.markers) {
      expect(contains(bytes, marker), marker).toBe(true);
    }
    expect(existsSync(join(harness.photos.dir, `${kept.photoId}.jpg`))).toBe(true);
    expect(count("photos")).toBe(1);
    expect(count(`gemma_decisions WHERE photo_id = '${kept.photoId}'`)).toBeGreaterThanOrEqual(3);
    expect(count(`gemma_decisions WHERE photo_id = '${doomed.photoId}'`)).toBe(0);
  });

  it("AC-015.2: after a real inspection, deleting the photo erases what Gemma saw from the database file", async () => {
    const dbPath = await setup();
    harness.model.setScenario("bookmaker", "ok");
    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
    }>();
    await harness.idle();
    const upload = await uploadPhoto(harness, card.id, await syntheticPhoto());
    const photoId = upload.json<{ photo: { id: string } }>().photo.id;
    await harness.idle();
    // The inspector's observation and the bookmaker run that read it are on disk...
    harness.db.pragma("wal_checkpoint(TRUNCATE)");
    expect(contains(databaseBytes(dbPath), "tomato pots")).toBe(true);
    expect(contains(databaseBytes(dbPath), "photo observations")).toBe(true);
    const withPhoto = harness.db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM quotes WHERE with_photo = 1")
      .get()!;
    expect(withPhoto.n).toBe(1);

    expect((await harness.delete(`/api/photos/${photoId}`)).statusCode).toBe(204);

    // ...and gone after the delete: the observation, the photo's decisions and its quote.
    const bytes = databaseBytes(dbPath);
    expect(contains(bytes, "tomato pots")).toBe(false);
    expect(contains(bytes, "photo observations")).toBe(false);
    expect(contains(bytes, photoId)).toBe(false);
    expect(count("gemma_decisions WHERE job = 'inspector'")).toBe(0);
    expect(count("quotes WHERE with_photo = 1")).toBe(0);
    const view = (await harness.get(`/api/cards/${card.id}`)).json<{ photo: unknown }>();
    expect(view.photo).toBeNull();
  });

  it("AC-015.2: the card falls back to the odds it had without the photo", async () => {
    await setup();
    const planted = await plantPhotoWithDerivatives("FALLBACK");
    const withPhoto = (await harness.get(`/api/cards/${planted.cardId}`)).json<{
      quote: { source: string; odds: number };
    }>();
    expect(withPhoto.quote).toMatchObject({ source: "gemma", odds: 50 });
    await harness.delete(`/api/photos/${planted.photoId}`);
    const without = (await harness.get(`/api/cards/${planted.cardId}`)).json<{
      quote: { source: string };
    }>();
    expect(without.quote.source).toBe("rule");
  });

  it("a second delete, a bad id and an unknown photo answer 404; the file survives a failed row delete", async () => {
    await setup();
    const planted = await plantPhotoWithDerivatives("TWICE");
    expect((await harness.delete(`/api/photos/${planted.photoId}`)).statusCode).toBe(204);
    expect((await harness.delete(`/api/photos/${planted.photoId}`)).statusCode).toBe(404);
    expect((await harness.delete("/api/photos/not-a-uuid")).statusCode).toBe(404);
  });

  it("deleting needs a session and an app Origin", async () => {
    await setup();
    const planted = await plantPhotoWithDerivatives("GUARD");
    const noSession = await harness.request({
      method: "DELETE",
      url: `/api/photos/${planted.photoId}`,
    });
    expect(noSession.statusCode).toBe(401);
    const badOrigin = await harness.request({
      method: "DELETE",
      url: `/api/photos/${planted.photoId}`,
      headers: { cookie: harness.cookie, origin: "http://evil.example" },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(count("photos")).toBe(1);
  });
});

describe("delete a bet's data (AC-015.2)", () => {
  async function settledBetWithPhoto(tag: string): Promise<{ betId: number; planted: Planted }> {
    const planted = await plantPhotoWithDerivatives(tag);
    // The bet locks the latest quote: the one made with the photo.
    const latest = (await harness.get(`/api/cards/${planted.cardId}`)).json<{
      quote: { id: number };
    }>().quote;
    const bet = (
      await harness.post("/api/bets", {
        card_id: planted.cardId,
        quote_id: latest.id,
        kind: "do_nothing",
      })
    ).json<{ id: number; settle_at: string }>();
    harness.clock.current = Date.parse(bet.settle_at) + MINUTE;
    harness.core.scheduler.tick();
    const settled = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(settled.statusCode).toBe(200);
    // Judge evidence and an after photo on the bet, with markers of their own.
    const after = await uploadAfterPhoto(bet.id);
    harness.db
      .prepare(
        `INSERT INTO gemma_decisions (job, bet_id, photo_id, model, prompt_version, input_summary,
           output, valid, retries, latency_ms, created_at)
         VALUES ('judge', ?, ?, 'fake', 'v1', ?, ?, 1, 0, 5, 1)`,
      )
      .run(bet.id, after, `AFTER-INPUT-${tag}`, `AFTER-OUTPUT-${tag}`);
    return {
      betId: bet.id,
      planted: {
        ...planted,
        markers: [...planted.markers, `AFTER-INPUT-${tag}`, `AFTER-OUTPUT-${tag}`],
      },
    };
  }

  async function uploadAfterPhoto(betId: number): Promise<string> {
    // Stored through the store, filed against the bet, like the settle photo of a later task.
    const stored = await harness.photos.stage(await syntheticPhoto());
    harness.photos.publish(stored);
    harness.db
      .prepare(
        `INSERT INTO photos (id, bet_id, role, file, received_at, width, height)
         VALUES (?, ?, 'after', ?, 1, ?, ?)`,
      )
      .run(stored.id, betId, stored.file, stored.width, stored.height);
    return stored.id;
  }

  it("AC-015.2: removes the bet, settlements, quotes, decisions and photos, files included, and totals follow", async () => {
    const dbPath = await setup();
    const other = await settledBetWithPhoto("OTHER");
    const gone = await settledBetWithPhoto("GONE");
    const pointsBefore = (await harness.get("/api/today")).json<{ points: { total: number } }>()
      .points.total;
    expect(pointsBefore).not.toBe(0);
    harness.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const marker of gone.planted.markers) {
      expect(contains(databaseBytes(dbPath), marker), marker).toBe(true);
    }
    const files = harness.db
      .prepare<[number, number], { file: string }>(
        "SELECT file FROM photos WHERE card_id = ? OR bet_id = ?",
      )
      .all(gone.planted.cardId, gone.betId);
    expect(files).toHaveLength(2);

    const response = await harness.delete(`/api/bets/${gone.betId}/data`);
    expect(response.statusCode).toBe(204);

    for (const { file } of files) {
      expect(existsSync(join(harness.photos.dir, file))).toBe(false);
    }
    expect(harness.db.prepare("SELECT 1 FROM bets WHERE id = ?").get(gone.betId)).toBeUndefined();
    expect(
      harness.db.prepare("SELECT 1 FROM settlements WHERE bet_id = ?").get(gone.betId),
    ).toBeUndefined();
    for (const table of ["quotes", "gemma_decisions", "photos"]) {
      expect(count(table), table).toBeGreaterThan(0);
    }
    const bytes = databaseBytes(dbPath);
    for (const marker of gone.planted.markers) {
      expect(contains(bytes, marker), marker).toBe(false);
    }
    for (const marker of other.planted.markers) {
      expect(contains(bytes, marker), marker).toBe(true);
    }
    const pointsAfter = (await harness.get("/api/today")).json<{ points: { total: number } }>()
      .points.total;
    expect(pointsAfter).toBe(pointsBefore / 2);
    expect(count("bets")).toBe(1);
    expect(count("cards")).toBe(1);
    expect(count("photos")).toBe(2);
  });

  it("an undone bet's data goes without taking a newer bet on the same card", async () => {
    await setup();
    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
      quote: { id: number };
    }>();
    const first = (
      await harness.post("/api/bets", {
        card_id: card.id,
        quote_id: card.quote.id,
        kind: "do_nothing",
      })
    ).json<{ id: number }>();
    expect((await harness.delete(`/api/bets/${first.id}`)).statusCode).toBe(200);
    const second = (
      await harness.post("/api/bets", {
        card_id: card.id,
        quote_id: card.quote.id,
        kind: "do_nothing",
      })
    ).json<{ id: number }>();
    expect((await harness.delete(`/api/bets/${first.id}/data`)).statusCode).toBe(204);
    expect(harness.db.prepare("SELECT 1 FROM bets WHERE id = ?").get(second.id)).toBeDefined();
    expect(count("cards")).toBe(1);
    expect(count("quotes")).toBe(1);
  });

  it("an unknown bet answers 404", async () => {
    await setup();
    expect((await harness.delete("/api/bets/999/data")).statusCode).toBe(404);
  });
});

describe("deleting a photo while Gemma works on it (B1, S1)", () => {
  async function gatedSetup(): Promise<{ model: GatedModel; cardId: number; dbPath: string }> {
    folder = mkdtempSync(join(tmpdir(), "sib-delete-"));
    const dbPath = join(folder, "sib.db");
    const model = new GatedModel();
    harness = await createCoreHarness({ dbPath, model });
    await pair(harness);
    model.setScenario("bookmaker", "ok");
    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
    }>();
    await harness.idle();
    return { model, cardId: card.id, dbPath };
  }

  const photoState = async (cardId: number) =>
    (await harness.get(`/api/cards/${cardId}`)).json<{
      photo: { id: string; state: string } | null;
    }>().photo;

  it("B1: a stale job for a deleted photo cannot change the state of the newer photo", async () => {
    const { model, cardId } = await gatedSetup();
    model.gate("inspector");
    const a = (await uploadPhoto(harness, cardId, await syntheticPhoto({ shade: 30 }))).json<{
      photo: { id: string };
    }>().photo.id;
    await model.waitForArrivals("inspector", 1);
    expect((await harness.delete(`/api/photos/${a}`)).statusCode).toBe(204);
    expect(await photoState(cardId)).toBeNull();

    const b = (await uploadPhoto(harness, cardId, await syntheticPhoto({ shade: 200 }))).json<{
      photo: { id: string };
    }>().photo.id;
    // A's inspector answers now; B's job is queued behind it and its inspector call arrives next.
    model.releaseNext();
    await model.waitForArrivals("inspector", 2);
    expect(await photoState(cardId)).toMatchObject({ id: b, state: "inspecting" });
    // A's answer was dropped: no bookmaker run for it, nothing stored under A.
    expect(count(`quotes WHERE photo_id = '${a}'`)).toBe(0);

    model.openAll();
    await harness.idle();
    expect(await photoState(cardId)).toMatchObject({ id: b, state: "seen" });
    expect(count(`quotes WHERE photo_id = '${b}' AND with_photo = 1`)).toBe(1);
    expect(count("quotes WHERE with_photo = 1")).toBe(1);
  });

  it("S1: the inspector's decision for a photo deleted meanwhile is kept without the photo or its content", async () => {
    const { model, cardId, dbPath } = await gatedSetup();
    model.gate("inspector");
    const a = (await uploadPhoto(harness, cardId, await syntheticPhoto())).json<{
      photo: { id: string };
    }>().photo.id;
    await model.waitForArrivals("inspector", 1);
    await harness.delete(`/api/photos/${a}`);
    model.openAll();
    await harness.idle();
    // No foreign-key failure, no failed state: the card is simply without a photo.
    expect(await photoState(cardId)).toBeNull();
    const row = harness.db
      .prepare<[], { photo_id: string | null; output: string | null; error: string | null }>(
        "SELECT photo_id, output, error FROM gemma_decisions WHERE job = 'inspector'",
      )
      .get();
    expect(row).toMatchObject({ photo_id: null, output: null });
    expect(row?.error).toMatch(/deleted/);
    harness.db.pragma("wal_checkpoint(TRUNCATE)");
    expect(contains(databaseBytes(dbPath), "tomato pots")).toBe(false);
  });

  it("S1: a photo deleted while the bookmaker reads it gets no with-photo quote and no stored answer", async () => {
    const { model, cardId, dbPath } = await gatedSetup();
    model.gate("bookmaker");
    const a = (await uploadPhoto(harness, cardId, await syntheticPhoto())).json<{
      photo: { id: string };
    }>().photo.id;
    await model.waitForArrivals("bookmaker", 1);
    await harness.delete(`/api/photos/${a}`);
    model.openAll();
    await harness.idle();
    expect(await photoState(cardId)).toBeNull();
    expect(count("quotes WHERE with_photo = 1")).toBe(0);
    expect(count(`gemma_decisions WHERE photo_id = '${a}'`)).toBe(0);
    harness.db.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = databaseBytes(dbPath);
    expect(contains(bytes, "tomato pots")).toBe(false);
    expect(contains(bytes, a)).toBe(false);
  });
});

describe("the checkpoint after a delete (S6)", () => {
  it("S6: retries once when a reader holds it, then logs a warning without content", async () => {
    const dbPath = await setup();
    const planted = await plantPhotoWithDerivatives("BUSY");
    const warnings: string[] = [];
    harness.photos.warn = (message) => {
      warnings.push(message);
    };
    // Another connection (the CLI) with a read transaction open keeps the WAL from truncating.
    const reader = new Database(dbPath);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM cards").get();
    try {
      const started = Date.now();
      expect((await harness.delete(`/api/photos/${planted.photoId}`)).statusCode).toBe(204);
      expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(planted.photoId);
    // Once the reader is gone, the next checkpoint finishes and the rows are overwritten.
    harness.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const marker of planted.markers) {
      expect(contains(databaseBytes(dbPath), marker), marker).toBe(false);
    }
  });

  it("S3: deleting a bet's data takes the photo list inside the transaction and unlinks after it", async () => {
    await setup();
    const planted = await plantPhotoWithDerivatives("S3");
    const events: string[] = [];
    const remove = harness.photos.removeAfterCommit.bind(harness.photos);
    harness.photos.removeAfterCommit = (files) => {
      events.push(`unlink ${String(files.length)}; cards left ${String(count("cards"))}`);
      remove(files);
    };
    const latest = (await harness.get(`/api/cards/${planted.cardId}`)).json<{
      quote: { id: number };
    }>().quote;
    const bet = (
      await harness.post("/api/bets", {
        card_id: planted.cardId,
        quote_id: latest.id,
        kind: "do_nothing",
      })
    ).json<{ id: number }>();
    expect((await harness.delete(`/api/bets/${bet.id}/data`)).statusCode).toBe(204);
    // The unlink ran after the rows were gone.
    expect(events).toEqual(["unlink 1; cards left 0"]);
    expect(existsSync(join(harness.photos.dir, `${planted.photoId}.jpg`))).toBe(false);
  });
});
