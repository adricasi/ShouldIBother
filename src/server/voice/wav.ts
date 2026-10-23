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
  /**
   * What the model receives: a canonical WAV (44-byte header and the measured samples), rebuilt
   * from the upload. Whatever else the file held (trailing chunks, metadata, bytes after the data)
   * is dropped, so the model hears exactly what the length check measured.
   */
  readonly audio: Buffer;
}

function unsupported(detail: string): HttpError {
  return new HttpError(415, "Voice notes must be WAV audio", detail);
}

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/** A 44-byte canonical header for 16-bit PCM followed by `data`. */
function canonicalWav(format: { channels: number; sampleRate: number }, data: Uint8Array): Buffer {
  const blockAlign = format.channels * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Checks that `bytes` is a 16-bit PCM WAV of at most `MAX_VOICE_SECONDS` and returns its length
 * and a canonical copy to send on. The phone converts its recording to this format
 * (`src/web/voice/`); anything else is refused before it reaches the model, so the server never
 * decodes untrusted compressed audio. One `fmt ` chunk before one `data` chunk, a consistent
 * block alignment and byte rate; a second `fmt ` or `data` chunk is refused, not guessed at.
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
  let data: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (format !== undefined) {
        throw unsupported("The WAV has more than one format chunk.");
      }
      if (size < 16 || body + 16 > bytes.length) {
        throw unsupported("The WAV header is damaged.");
      }
      const encoding = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (encoding !== 1 || bits !== 16 || channels < 1 || channels > 2) {
        throw unsupported("Send 16-bit PCM, mono or stereo.");
      }
      if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
        throw unsupported("The sample rate is out of range.");
      }
      if (blockAlign !== channels * BYTES_PER_SAMPLE || byteRate !== sampleRate * blockAlign) {
        throw unsupported("The WAV header does not add up.");
      }
      format = { channels, sampleRate };
    } else if (id === "data") {
      if (format === undefined) {
        throw unsupported("The WAV header is damaged.");
      }
      if (data !== undefined) {
        throw unsupported("The WAV has more than one data chunk.");
      }
      // A streamed WAV may declare more data than it holds; trust the bytes that are there, and
      // only whole sample frames of them.
      const frame = format.channels * BYTES_PER_SAMPLE;
      const available = Math.min(size, bytes.length - body);
      data = bytes.subarray(body, body + available - (available % frame));
    }
    // Chunks are word aligned; a chunk always moves the walk on, so a zero-size one cannot loop,
    // and a huge declared size simply ends it.
    offset = body + size + (size % 2);
  }
  if (format === undefined || data === undefined) {
    throw unsupported("The WAV has no audio data.");
  }
  const durationMs = Math.round(
    (data.length / (format.sampleRate * format.channels * BYTES_PER_SAMPLE)) * 1000,
  );
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
  return { ...format, durationMs, audio: canonicalWav(format, data) };
}
