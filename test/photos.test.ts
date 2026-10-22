import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { PHOTO_ID } from "../src/server/photos/store.js";
import { UNSUPPORTED_PHOTO_MESSAGE } from "../src/server/photos/process.js";

import { createCoreHarness, pair, uploadPhoto, type CoreHarness } from "./core-helpers.js";
import { LOCAL_HOST } from "./helpers.js";
import { PLANTED_METADATA, syntheticPhoto } from "./support/photos.js";

let harness: CoreHarness;
afterEach(async () => {
  await harness.close();
});

async function setup(): Promise<CoreHarness> {
  harness = await createCoreHarness();
  await pair(harness);
  return harness;
}

async function newCard(): Promise<number> {
  const response = await harness.post("/api/cards/quick", { chore_type: "plants" });
  expect(response.statusCode).toBe(201);
  await harness.idle();
  return response.json<{ id: number }>().id;
}

interface Uploaded {
  photo: { id: string; url: string; width: number; height: number };
}

function photoFiles(): string[] {
  return readdirSync(harness.photos.dir);
}

function tableCount(table: string): number {
  return harness.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

describe("photo store", () => {
  it("AC-005.1: strips EXIF, GPS, ICC and XMP and fits 1024 px, applying the orientation first", async () => {
    await setup();
    const cardId = await newCard();
    // 2400 x 1600 stored sideways: shown upright it is 1600 x 2400.
    const input = await syntheticPhoto({
      width: 2400,
      height: 1600,
      orientation: 6,
      withMetadata: true,
    });
    const inputMetadata = await sharp(input).metadata();
    expect(inputMetadata.exif).toBeDefined();
    expect(inputMetadata.icc).toBeDefined();
    expect(inputMetadata.xmp).toBeDefined();
    expect(input.includes(Buffer.from("TestCameraMaker"))).toBe(true);

    const response = await uploadPhoto(harness, cardId, input);
    expect(response.statusCode).toBe(201);
    const { photo } = response.json<Uploaded>();
    expect(Math.max(photo.width, photo.height)).toBe(1024);
    expect(photo.height).toBe(1024);
    expect(photo.width).toBe(683);

    const [file] = photoFiles();
    const stored = readFileSync(join(harness.photos.dir, file!));
    const metadata = await sharp(stored).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(1024);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    // No metadata segment of any kind: no EXIF header, no GPS tag names, none of the planted text.
    expect(stored.includes(Buffer.from("Exif"))).toBe(false);
    expect(stored.includes(Buffer.from("http://ns.adobe.com"))).toBe(false);
    for (const marker of PLANTED_METADATA) {
      expect(stored.includes(Buffer.from(marker))).toBe(false);
    }
  });

  it("AC-005.1: PNG with transparency and WebP are re-encoded as JPEG, small photos are not enlarged", async () => {
    await setup();
    const cardId = await newCard();
    const png = await uploadPhoto(
      harness,
      cardId,
      await syntheticPhoto({ format: "png", alpha: true, width: 300, height: 200 }),
      { fileName: "a.png", contentType: "image/png" },
    );
    expect(png.statusCode).toBe(201);
    expect(png.json<Uploaded>().photo).toMatchObject({ width: 300, height: 200 });
    await harness.idle();
    expect((await sharp(join(harness.photos.dir, photoFiles()[0]!)).metadata()).format).toBe(
      "jpeg",
    );
    const webp = await uploadPhoto(
      harness,
      cardId,
      await syntheticPhoto({ format: "webp", width: 1500, height: 900 }),
      { fileName: "a.webp", contentType: "image/webp" },
    );
    expect(webp.statusCode).toBe(201);
    expect(webp.json<Uploaded>().photo).toMatchObject({ width: 1024, height: 614 });
    for (const file of photoFiles()) {
      expect((await sharp(join(harness.photos.dir, file)).metadata()).format).toBe("jpeg");
    }
  });

  it("NFR-002: files get random UUID names, the folder is 0700 and the files 0600", async () => {
    await setup();
    const cardId = await newCard();
    const first = await uploadPhoto(harness, cardId, await syntheticPhoto());
    const { id } = first.json<Uploaded>().photo;
    expect(id).toMatch(PHOTO_ID);
    expect(photoFiles()).toEqual([`${id}.jpg`]);
    expect(statSync(harness.photos.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(harness.photos.dir, `${id}.jpg`)).mode & 0o777).toBe(0o600);
    await harness.idle();
    // A second photo replaces the first: its file and rows are gone, the name is new.
    const second = await uploadPhoto(harness, cardId, await syntheticPhoto());
    const next = second.json<Uploaded>().photo.id;
    expect(next).toMatch(PHOTO_ID);
    expect(next).not.toBe(id);
    expect(photoFiles()).toEqual([`${next}.jpg`]);
    expect(tableCount("photos")).toBe(1);
  });

  it("AC-005.6: a non-image gets 415 with the message and the card, quotes and folder are unchanged", async () => {
    await setup();
    const cardId = await newCard();
    const before = {
      cards: tableCount("cards"),
      quotes: tableCount("quotes"),
      photos: tableCount("photos"),
      card: (await harness.get(`/api/cards/${cardId}`)).json<unknown>(),
    };
    for (const bytes of [
      Buffer.from("this is a text file, not a picture"),
      Buffer.alloc(0),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"></svg>'),
      (await syntheticPhoto()).subarray(0, 40),
    ]) {
      const response = await uploadPhoto(harness, cardId, bytes, { fileName: "x.jpg" });
      expect(response.statusCode).toBe(415);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json<{ detail: string }>().detail).toBe(UNSUPPORTED_PHOTO_MESSAGE);
    }
    expect(photoFiles()).toEqual([]);
    expect(tableCount("cards")).toBe(before.cards);
    expect(tableCount("quotes")).toBe(before.quotes);
    expect(tableCount("photos")).toBe(before.photos);
    expect((await harness.get(`/api/cards/${cardId}`)).json<unknown>()).toEqual(before.card);
  });

  it("AC-005.6: a format the build cannot decode (an HEIC header, GIF, TIFF) gets 415", async () => {
    await setup();
    const cardId = await newCard();
    // The installed sharp decodes AVIF through libheif but ships no HEVC decoder, so a HEIC
    // (brand "heic") is refused; GIF and TIFF are decodable but not accepted formats.
    const heicHeader = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("mif1heic"),
      Buffer.alloc(64),
    ]);
    for (const bytes of [
      heicHeader,
      await syntheticPhoto({ format: "gif", width: 20, height: 20 }),
      await syntheticPhoto({ format: "tiff", width: 20, height: 20 }),
    ]) {
      const response = await uploadPhoto(harness, cardId, bytes, {
        fileName: "x.heic",
        contentType: "image/heic",
      });
      expect(response.statusCode).toBe(415);
      expect(response.json<{ detail: string }>().detail).toBe(UNSUPPORTED_PHOTO_MESSAGE);
    }
    expect(photoFiles()).toEqual([]);
  });

  it("AC-005.6: a request that is not multipart gets 415 too", async () => {
    await setup();
    const cardId = await newCard();
    const response = await harness.post(`/api/cards/${cardId}/photo`, { photo: "nope" });
    expect(response.statusCode).toBe(415);
    expect(response.json<{ detail: string }>().detail).toBe(UNSUPPORTED_PHOTO_MESSAGE);
  });

  it("a file over 10 MB gets 413 and leaves nothing behind", async () => {
    await setup();
    const cardId = await newCard();
    const response = await uploadPhoto(harness, cardId, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    expect(response.statusCode).toBe(413);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(photoFiles()).toEqual([]);
    expect(tableCount("photos")).toBe(0);
  });

  it("a card that does not exist, or has a bet, takes no photo", async () => {
    await setup();
    const missing = await uploadPhoto(harness, 9999, await syntheticPhoto());
    expect(missing.statusCode).toBe(404);
    const cardId = await newCard();
    const quote = (await harness.get(`/api/cards/${cardId}`)).json<{ quote: { id: number } }>()
      .quote;
    const bet = await harness.post("/api/bets", {
      card_id: cardId,
      quote_id: quote.id,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(201);
    const late = await uploadPhoto(harness, cardId, await syntheticPhoto());
    expect(late.statusCode).toBe(409);
    expect(photoFiles()).toEqual([]);
  });
});

describe("serving photos", () => {
  it("NFR-002: GET /photos/:id needs a session and is never cached or sniffed", async () => {
    await setup();
    const cardId = await newCard();
    const { photo } = (await uploadPhoto(harness, cardId, await syntheticPhoto())).json<Uploaded>();

    const anonymous = await harness.request({ method: "GET", url: photo.url });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.rawPayload.length).toBeLessThan(500);

    const served = await harness.get(photo.url);
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.headers["cache-control"]).toBe("private, no-store");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(
      served.rawPayload.equals(readFileSync(join(harness.photos.dir, `${photo.id}.jpg`))),
    ).toBe(true);
  });

  it("answers 404 for an unknown id and for names that are not a photo id", async () => {
    await setup();
    for (const id of ["00000000-0000-4000-8000-000000000000", "..%2F..%2Fsib.db", "not-a-uuid"]) {
      const response = await harness.get(`/photos/${id}`);
      expect(response.statusCode).toBe(404);
    }
  });

  it("answers 404 when the row exists but the file is gone", async () => {
    await setup();
    const cardId = await newCard();
    const { photo } = (await uploadPhoto(harness, cardId, await syntheticPhoto())).json<Uploaded>();
    harness.photos.remove(`${photo.id}.jpg`);
    expect((await harness.get(photo.url)).statusCode).toBe(404);
  });

  it("serves only to an allowed Host", async () => {
    await setup();
    const response = await harness.request({
      method: "GET",
      url: "/photos/00000000-0000-4000-8000-000000000000",
      headers: { host: "evil.example", cookie: harness.cookie },
    });
    expect(response.statusCode).toBe(421);
    expect(LOCAL_HOST).not.toBe("evil.example");
  });
});
