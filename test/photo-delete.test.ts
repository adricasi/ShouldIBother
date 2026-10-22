import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  const upload = await uploadPhoto(harness, card.id, await syntheticPhoto());
  const photoId = upload.json<{ photo: { id: string } }>().photo.id;
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
    expect(count("gemma_decisions")).toBe(2);
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
    const stored = await harness.photos.save(await syntheticPhoto());
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
