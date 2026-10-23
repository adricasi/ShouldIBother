/**
 * Synthetic voice notes, generated in code (never a real recording): a 16-bit PCM WAV holding a
 * quiet tone or silence, so tests have audio to upload without any household sound.
 */
export interface SyntheticWavOptions {
  readonly seconds?: number;
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  /** Silence when false; a 440 Hz tone otherwise. */
  readonly tone?: boolean;
}

export function syntheticWav(options: SyntheticWavOptions = {}): Buffer {
  const seconds = options.seconds ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * channels * 2);
  if (options.tone !== false) {
    for (let frame = 0; frame < frames; frame += 1) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 3000);
      for (let channel = 0; channel < channels; channel += 1) {
        data.writeInt16LE(sample, (frame * channels + channel) * 2);
      }
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
