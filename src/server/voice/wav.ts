import { HttpError } from "../problem.js";

/** A voice note is at most this many bytes (about 60 s of 16 kHz mono); a larger upload is cut off. */
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;
/** ... and at most this many seconds long (REQ-027: a short note, not a recording). */
export const MAX_VOICE_SECONDS = 30;

const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: number;
}

function unsupported(detail: string): HttpError {
  return new HttpError(415, "Voice notes must be WAV audio", detail);
}

/**
 * Checks that `bytes` is a 16-bit PCM WAV of at most `MAX_VOICE_SECONDS` and returns its length.
 * The phone converts its recording to this format (`src/web/voice/`); anything else is refused
 * before it reaches the model, so the server never has to decode untrusted compressed audio.
 */
export function inspectWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(
      ...[0, 1, 2, 3].map((i) => (offset + i < bytes.length ? view.getUint8(offset + i) : 0)),
    );
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw unsupported("That is not a WAV file.");
  }
  let format: { channels: number; sampleRate: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) {
        throw unsupported("The WAV header is damaged.");
      }
      const encoding = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (encoding !== 1 || bits !== 16 || channels < 1 || channels > 2) {
        throw unsupported("Send 16-bit PCM, mono or stereo.");
      }
      if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
        throw unsupported("The sample rate is out of range.");
      }
      format = { channels, sampleRate };
    } else if (id === "data") {
      if (format === undefined) {
        throw unsupported("The WAV header is damaged.");
      }
      // A streamed WAV may declare more data than it holds; trust the bytes that are there.
      const dataBytes = Math.min(size, bytes.length - body);
      const durationMs = Math.round((dataBytes / (format.sampleRate * format.channels * 2)) * 1000);
      if (durationMs <= 0) {
        throw new HttpError(400, "The voice note is empty");
      }
      if (durationMs > MAX_VOICE_SECONDS * 1000) {
        throw new HttpError(
          413,
          "Voice note too long",
          `Voice notes can be at most ${MAX_VOICE_SECONDS} seconds.`,
        );
      }
      return { ...format, durationMs };
    }
    // Chunks are word aligned.
    offset = body + size + (size % 2);
  }
  throw unsupported("The WAV has no audio data.");
}
