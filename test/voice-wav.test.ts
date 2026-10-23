import { describe, expect, it } from "vitest";

import { HttpError } from "../src/server/problem.js";
import { MAX_VOICE_SECONDS, inspectWav } from "../src/server/voice/wav.js";
import {
  MAX_RECORD_SECONDS,
  VOICE_SAMPLE_RATE,
  encodeWav,
  levelOf,
} from "../src/web/voice/wav-encoder.js";

import { syntheticWav } from "./support/audio.js";

describe("the WAV the phone sends is the WAV the server accepts", () => {
  it("AC-027.1: encodes mono 16-bit PCM at 16 kHz that the server reads back with its length", () => {
    const samples = new Float32Array(VOICE_SAMPLE_RATE * 2).map((_, i) =>
      Math.sin((2 * Math.PI * 440 * i) / VOICE_SAMPLE_RATE),
    );
    const wav = Buffer.from(encodeWav(samples, VOICE_SAMPLE_RATE));
    expect(wav.length).toBe(44 + samples.length * 2);
    const info = inspectWav(wav);
    expect(info).toMatchObject({ sampleRate: VOICE_SAMPLE_RATE, channels: 1, durationMs: 2000 });
    // What the phone encodes is already canonical: the server forwards the same bytes.
    expect(info.audio.equals(wav)).toBe(true);
  });

  it("clamps samples outside [-1, 1] instead of wrapping them", () => {
    const wav = Buffer.from(encodeWav(new Float32Array([2, -2, 0]), VOICE_SAMPLE_RATE));
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([
      32767, -32768, 0,
    ]);
  });

  it("the longest note the phone records is inside the server's length cap", () => {
    expect(MAX_RECORD_SECONDS).toBeLessThan(MAX_VOICE_SECONDS);
  });

  it("measures loudness from silence to full scale", () => {
    expect(levelOf(new Float32Array(0))).toBe(0);
    expect(levelOf(new Float32Array(100))).toBe(0);
    expect(levelOf(new Float32Array(100).fill(1))).toBe(1);
  });
});

describe("the server's WAV check", () => {
  const status = (bytes: Buffer): number => {
    try {
      inspectWav(bytes);
      return 200;
    } catch (error) {
      return error instanceof HttpError ? error.status : 500;
    }
  };

  it("accepts mono and stereo 16-bit PCM between 8 and 48 kHz", () => {
    expect(inspectWav(syntheticWav({ channels: 2, sampleRate: 44_100, seconds: 1 }))).toMatchObject(
      { channels: 2, sampleRate: 44_100, durationMs: 1000 },
    );
  });

  it("refuses other encodings, bit depths, rates and channel counts with 415", () => {
    const base = syntheticWav();
    const patch = (offset: number, bytes: number, value: number): Buffer => {
      const copy = Buffer.from(base);
      if (bytes === 2) copy.writeUInt16LE(value, offset);
      else copy.writeUInt32LE(value, offset);
      return copy;
    };
    expect(status(patch(20, 2, 3))).toBe(415); // float, not PCM
    expect(status(patch(34, 2, 8))).toBe(415); // 8-bit
    expect(status(patch(24, 4, 4_000))).toBe(415); // too slow
    expect(status(patch(24, 4, 96_000))).toBe(415); // too fast
    expect(status(patch(22, 2, 6))).toBe(415); // six channels
  });

  it("refuses a truncated or headerless file and a header with no data", () => {
    expect(status(Buffer.alloc(0))).toBe(415);
    expect(status(syntheticWav().subarray(0, 30))).toBe(415);
    expect(status(syntheticWav().subarray(0, 36))).toBe(415);
  });

  it("trusts the bytes that are there when the header claims more than the file holds", () => {
    const wav = syntheticWav({ seconds: 1 });
    wav.writeUInt32LE(0xffffffff, 40);
    expect(inspectWav(wav).durationMs).toBe(1000);
  });
});

/** A chunk as it sits in a RIFF file: tag, little-endian size, body (and the pad byte if odd). */
function chunk(tag: string, body: Buffer, declaredSize = body.length): Buffer {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "ascii");
  head.writeUInt32LE(declaredSize, 4);
  return Buffer.concat([head, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** The `fmt ` and `data` chunks of a synthetic note, split so a test can insert others around them. */
function parts(options: Parameters<typeof syntheticWav>[0] = {}): { fmt: Buffer; data: Buffer } {
  const wav = syntheticWav(options);
  return { fmt: wav.subarray(12, 36), data: wav.subarray(36) };
}

function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

describe("the WAV the model receives is exactly what was measured", () => {
  const status = (bytes: Buffer): number => {
    try {
      inspectWav(bytes);
      return 200;
    } catch (error) {
      return error instanceof HttpError ? error.status : 500;
    }
  };

  it("returns a canonical copy: a plain note comes back byte for byte", () => {
    const wav = syntheticWav({ seconds: 0.5 });
    expect(inspectWav(wav).audio.equals(wav)).toBe(true);
  });

  it("drops chunks after the data and bytes after the last chunk, so the model never hears them", () => {
    const { fmt, data } = parts({ seconds: 1 });
    const trailing = Buffer.concat([
      chunk("LIST", Buffer.alloc(40_000, 7)),
      Buffer.from("trailing junk that is not a chunk"),
    ]);
    const padded = riff(fmt, data, trailing);
    const info = inspectWav(padded);
    expect(info.durationMs).toBe(1000);
    expect(info.audio.equals(syntheticWav({ seconds: 1 }))).toBe(true);
    expect(info.audio.length).toBeLessThan(padded.length);
  });

  it("drops a metadata chunk in front of the data too", () => {
    const { fmt, data } = parts({ seconds: 1 });
    const info = inspectWav(riff(fmt, chunk("LIST", Buffer.from("INFOsynthetic")), data));
    expect(info.audio.equals(syntheticWav({ seconds: 1 }))).toBe(true);
  });

  it("keeps only whole sample frames of a data chunk that ends mid-frame", () => {
    const { fmt, data } = parts({ seconds: 1, channels: 2 });
    const cut = data.subarray(0, data.length - 3);
    const info = inspectWav(riff(fmt, cut));
    expect((info.audio.length - 44) % 4).toBe(0);
  });

  it("refuses a second format chunk (an 8 kHz header hiding a 48 kHz stereo one)", () => {
    const slow = parts({ seconds: 1, sampleRate: 8_000 });
    const fast = parts({ seconds: 1, sampleRate: 48_000, channels: 2 });
    expect(status(riff(slow.fmt, fast.fmt, slow.data))).toBe(415);
    expect(status(riff(slow.fmt, slow.data, fast.fmt))).toBe(415);
  });

  it("refuses a second data chunk", () => {
    const { fmt, data } = parts({ seconds: 1 });
    expect(status(riff(fmt, data, data))).toBe(415);
  });

  it("refuses data before the format chunk", () => {
    const { fmt, data } = parts({ seconds: 1 });
    expect(status(riff(data, fmt))).toBe(415);
  });

  it("survives a zero-size chunk anywhere and still measures the data", () => {
    const { fmt, data } = parts({ seconds: 1 });
    const info = inspectWav(
      riff(chunk("JUNK", Buffer.alloc(0)), fmt, chunk("FLLR", Buffer.alloc(0)), data),
    );
    expect(info.durationMs).toBe(1000);
    expect(status(riff(fmt, chunk("data", Buffer.alloc(0))))).toBe(400);
  });

  it("a non-data chunk that declares a huge size ends the walk instead of hiding or inventing audio", () => {
    const { fmt, data } = parts({ seconds: 1 });
    // Before the data: the data is never reached, so there is no audio.
    expect(status(riff(fmt, chunk("LIST", Buffer.alloc(8), 0xfffffff0), data))).toBe(415);
    // After the data: the note is complete, and the huge claim is ignored.
    const after = riff(fmt, data, chunk("LIST", Buffer.alloc(8), 0xfffffff0));
    expect(inspectWav(after).audio.equals(syntheticWav({ seconds: 1 }))).toBe(true);
  });

  it("refuses a block alignment or byte rate that does not match the format", () => {
    const base = syntheticWav({ seconds: 1, channels: 2 });
    const patch = (offset: number, bytes: 2 | 4, value: number): Buffer => {
      const copy = Buffer.from(base);
      if (bytes === 2) copy.writeUInt16LE(value, offset);
      else copy.writeUInt32LE(value, offset);
      return copy;
    };
    expect(status(base)).toBe(200);
    expect(status(patch(32, 2, 2))).toBe(415); // block align of one channel
    expect(status(patch(32, 2, 8))).toBe(415);
    expect(status(patch(28, 4, 16_000 * 2))).toBe(415); // byte rate of one channel
    expect(status(patch(28, 4, 1))).toBe(415);
  });
});
