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
    expect(inspectWav(wav)).toEqual({
      sampleRate: VOICE_SAMPLE_RATE,
      channels: 1,
      durationMs: 2000,
    });
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
