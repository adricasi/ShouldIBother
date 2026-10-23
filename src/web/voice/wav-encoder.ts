/** What the server takes (`src/server/voice/wav.ts`): 16 kHz mono 16-bit PCM, at most 30 s. */
export const VOICE_SAMPLE_RATE = 16_000;
/** The phone stops listening after this long: a sentence or two, not a recording. */
export const MAX_RECORD_SECONDS = 20;

/** Encodes mono samples in [-1, 1] as a 16-bit PCM WAV. Pure, so it runs in tests without audio. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeTag = (offset: number, tag: string): void => {
    for (let i = 0; i < tag.length; i += 1) {
      view.setUint8(offset + i, tag.charCodeAt(i));
    }
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return buffer;
}

/** Root-mean-square level of a block of samples, 0 (silence) to 1 (full scale), for the meter. */
export function levelOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}
