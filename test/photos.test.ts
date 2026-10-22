import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PHOTO_ID } from "../src/server/photos/store.js";
import { UNSUPPORTED_PHOTO_MESSAGE } from "../src/server/photos/process.js";

import { sweepOrphanPhotos } from "../src/server/ledger/photos.js";
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
    expect(
      (await sharp(readFileSync(join(harness.photos.dir, photoFiles()[0]!))).metadata()).format,
    ).toBe("jpeg");
    const webp = await uploadPhoto(
      harness,
      cardId,
      await syntheticPhoto({ format: "webp", width: 1500, height: 900 }),
      { fileName: "a.webp", contentType: "image/webp" },
    );
    expect(webp.statusCode).toBe(201);
    expect(webp.json<Uploaded>().photo).toMatchObject({ width: 1024, height: 614 });
    for (const file of photoFiles()) {
      expect((await sharp(readFileSync(join(harness.photos.dir, file))).metadata()).format).toBe(
        "jpeg",
      );
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

/** A PNG header that claims `width` x `height` pixels, followed by almost no data. */
function pngClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("photo input hardening (S7)", () => {
  it("AC-005.6: an SVG, a PDF and a script are refused by their first bytes, never decoded", async () => {
    await setup();
    const cardId = await newCard();
    for (const text of [
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>',
      "%PDF-1.7 not a picture at all",
      "#!/bin/sh\necho not a picture either",
    ]) {
      const response = await uploadPhoto(harness, cardId, Buffer.from(text.padEnd(64, " ")), {
        fileName: "x.jpg",
        contentType: "image/jpeg",
      });
      expect(response.statusCode).toBe(415);
    }
    // Behind a JPEG signature the bytes still have to be a JPEG.
    const disguised = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(64, " ")),
    ]);
    expect((await uploadPhoto(harness, cardId, disguised)).statusCode).toBe(415);
    expect(photoFiles()).toEqual([]);
  });

  it("AC-005.6: GIF and TIFF are blocked in the decoder itself, not only by the signature check", async () => {
    const { processPhoto } = await import("../src/server/photos/process.js");
    await expect(processPhoto(await syntheticPhoto({ format: "gif" }))).rejects.toThrow(
      UNSUPPORTED_PHOTO_MESSAGE,
    );
    await expect(processPhoto(await syntheticPhoto({ format: "tiff" }))).rejects.toThrow(
      UNSUPPORTED_PHOTO_MESSAGE,
    );
  });

  it("a PNG whose header claims over 80 megapixels is refused from the header, without a decode", async () => {
    await setup();
    const cardId = await newCard();
    const bomb = pngClaiming(20_000, 20_000);
    expect(bomb.length).toBeLessThan(200);
    const started = Date.now();
    const response = await uploadPhoto(harness, cardId, bomb, {
      fileName: "x.png",
      contentType: "image/png",
    });
    expect(response.statusCode).toBe(415);
    expect(Date.now() - started).toBeLessThan(2_000);
    // A PNG of an ordinary size from the same hand-made header is not refused for its size.
    const { processPhoto } = await import("../src/server/photos/process.js");
    await expect(processPhoto(pngClaiming(64, 64))).rejects.toThrow();
    expect(photoFiles()).toEqual([]);
  });
});

describe("one upload at a time, and no orphan files (B2, N2, S5)", () => {
  it("B2: two concurrent uploads to a card give one 201, one 409 and one file", async () => {
    await setup();
    const cardId = await newCard();
    const [a, b] = await Promise.all([
      uploadPhoto(harness, cardId, await syntheticPhoto({ shade: 20 })),
      uploadPhoto(harness, cardId, await syntheticPhoto({ shade: 200 })),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    await harness.idle();
    expect(photoFiles()).toHaveLength(1);
    expect(tableCount("photos")).toBe(1);
  });

  it("B2: a bet placed while the photo is being processed refuses the photo and leaves no file", async () => {
    await setup();
    const cardId = await newCard();
    const quoteId = (await harness.get(`/api/cards/${cardId}`)).json<{ quote: { id: number } }>()
      .quote.id;
    const stage = harness.photos.stage.bind(harness.photos);
    vi.spyOn(harness.photos, "stage").mockImplementation(async (bytes) => {
      const staged = await stage(bytes);
      const bet = await harness.post("/api/bets", {
        card_id: cardId,
        quote_id: quoteId,
        kind: "do_nothing",
      });
      expect(bet.statusCode).toBe(201);
      return staged;
    });
    const response = await uploadPhoto(harness, cardId, await syntheticPhoto());
    expect(response.statusCode).toBe(409);
    expect(photoFiles()).toEqual([]);
    expect(tableCount("photos")).toBe(0);
  });

  it("B2: a card deleted while the photo is processed answers 404 and leaves no file", async () => {
    await setup();
    const cardId = await newCard();
    const stage = harness.photos.stage.bind(harness.photos);
    vi.spyOn(harness.photos, "stage").mockImplementation(async (bytes) => {
      const staged = await stage(bytes);
      harness.db.prepare("DELETE FROM cards WHERE id = ?").run(cardId);
      return staged;
    });
    expect((await uploadPhoto(harness, cardId, await syntheticPhoto())).statusCode).toBe(404);
    expect(photoFiles()).toEqual([]);
  });

  it("S5: a photo is written under a temporary name and gets its final name after the row exists", async () => {
    await setup();
    const cardId = await newCard();
    const seen: string[][] = [];
    const publish = harness.photos.publish.bind(harness.photos);
    vi.spyOn(harness.photos, "publish").mockImplementation((photo) => {
      seen.push(photoFiles());
      expect(tableCount("photos")).toBe(1);
      publish(photo);
    });
    const response = await uploadPhoto(harness, cardId, await syntheticPhoto());
    expect(response.statusCode).toBe(201);
    expect(seen[0]).toEqual([expect.stringMatching(/\.tmp$/)]);
    expect(photoFiles()).toEqual([expect.stringMatching(/\.jpg$/)]);
  });

  it("S5: the start-up sweep removes temporary files and photo files no row names, nothing else", async () => {
    await setup();
    const cardId = await newCard();
    const kept = (await uploadPhoto(harness, cardId, await syntheticPhoto())).json<Uploaded>()
      .photo;
    await harness.idle();
    const dir = harness.photos.dir;
    const orphanJpg = "11111111-2222-4333-8444-555555555555.jpg";
    const orphanTmp = "66666666-7777-4888-8999-aaaaaaaaaaaa.tmp";
    writeFileSync(join(dir, orphanJpg), "x");
    writeFileSync(join(dir, orphanTmp), "x");
    writeFileSync(join(dir, "notes.txt"), "not ours");
    expect(sweepOrphanPhotos({ db: harness.db, photos: harness.photos })).toBe(2);
    expect(photoFiles().sort()).toEqual([`${kept.id}.jpg`, "notes.txt"].sort());
  });

  it("S5: a file that cannot be removed after a delete is logged without its name and swept later", async () => {
    await setup();
    const warnings: string[] = [];
    harness.photos.warn = (message) => {
      warnings.push(message);
    };
    // A directory where a photo file should be: unlink fails with a non-ENOENT error.
    const name = "11111111-2222-4333-8444-555555555555.jpg";
    mkdirSync(join(harness.photos.dir, name));
    harness.photos.removeAfterCommit([name]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(name);
  });
});

describe("a full Gemma queue refuses the photo before anything changes (503)", () => {
  it("answers 503 problem+json 'Gemma is busy' and stores nothing", async () => {
    await setup();
    const cardId = await newCard();
    vi.spyOn(harness.core.gemma, "full", "get").mockReturnValue(true);
    const response = await uploadPhoto(harness, cardId, await syntheticPhoto());
    expect(response.statusCode).toBe(503);
    expect(response.json<{ title: string }>().title).toBe("Gemma is busy");
    expect(photoFiles()).toEqual([]);
    expect(tableCount("photos")).toBe(0);
  });
});
