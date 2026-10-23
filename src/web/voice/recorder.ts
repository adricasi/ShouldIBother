import { VOICE_SAMPLE_RATE, MAX_RECORD_SECONDS, encodeWav, levelOf } from "./wav-encoder.js";

/**
 * Records one short voice note. The sheet talks to this interface, so tests give it a fake and
 * never need a microphone. The recording lives in memory only: it is converted to WAV, uploaded
 * to the laptop and dropped; nothing is stored in the browser.
 */
export interface VoiceRecorder {
  /** Asks for the microphone and starts; `onLevel` gets the loudness (0 to 1) while it records. */
  start(onLevel: (level: number) => void): Promise<void>;
  /** Stops and returns the note as a 16 kHz mono WAV. */
  stop(): Promise<Blob>;
  /** Stops and throws everything away (the sheet was closed). */
  cancel(): void;
}

/** The person said no, or the browser has no microphone to give. */
export class MicrophoneError extends Error {
  override readonly name = "MicrophoneError";
}

/** The recording as the browser made it (webm or mp4) to the WAV the server takes. */
async function toWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const seconds = Math.min(decoded.duration, MAX_RECORD_SECONDS + 1);
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(seconds * VOICE_SAMPLE_RATE)),
      VOICE_SAMPLE_RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    // One channel in, so a stereo recording is mixed down and resampled in one step.
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Blob([encodeWav(rendered.getChannelData(0), VOICE_SAMPLE_RATE)], {
      type: "audio/wav",
    });
  } finally {
    await context.close();
  }
}

/** The real recorder: `getUserMedia` + `MediaRecorder`, with an analyser for the level meter. */
export function createBrowserRecorder(): VoiceRecorder {
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let meter: AudioContext | undefined;
  let frame: number | undefined;
  let chunks: Blob[] = [];
  /** Bumped by every start and cancel: a start that finds it changed was superseded. */
  let generation = 0;
  /** The `stop()` waiting for the recorder to finish, so a recorder error can settle it. */
  let failStop: ((error: Error) => void) | undefined;

  /** Gives everything back: the recorder, the meter, the animation frame and the microphone. */
  const release = (): void => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    if (recorder !== undefined) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // Already stopping: nothing left to release.
        }
      }
      recorder = undefined;
    }
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = undefined;
    void meter?.close().catch(() => undefined);
    meter = undefined;
  };

  return {
    async start(onLevel) {
      // A start after a failed or abandoned one must not inherit its microphone.
      release();
      generation += 1;
      const mine = generation;
      let granted: MediaStream;
      try {
        granted = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        throw new MicrophoneError("The microphone is blocked or missing", { cause: error });
      }
      if (mine !== generation) {
        // Cancelled or restarted while the browser was asking: give the microphone back.
        granted.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      stream = granted;
      chunks = [];
      try {
        recorder = new MediaRecorder(granted);
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onerror = () => {
          const settle = failStop;
          failStop = undefined;
          release();
          settle?.(new Error("The recording failed"));
        };
        recorder.start();
        meter = new AudioContext();
        const analyser = meter.createAnalyser();
        analyser.fftSize = 1024;
        meter.createMediaStreamSource(granted).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const tick = (): void => {
          analyser.getFloatTimeDomainData(samples);
          onLevel(levelOf(samples));
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (error) {
        // The microphone was granted but the setup failed: do not keep it open.
        release();
        throw error;
      }
    },

    stop() {
      const active = recorder;
      if (active === undefined) {
        return Promise.reject(new Error("Not recording"));
      }
      return new Promise<Blob>((resolve, reject) => {
        failStop = reject;
        active.onstop = () => {
          failStop = undefined;
          const recording = new Blob(chunks, { type: active.mimeType });
          chunks = [];
          release();
          toWav(recording).then(resolve, reject);
        };
        active.stop();
      });
    },

    cancel() {
      generation += 1;
      const settle = failStop;
      failStop = undefined;
      chunks = [];
      release();
      settle?.(new Error("The recording was cancelled"));
    },
  };
}
