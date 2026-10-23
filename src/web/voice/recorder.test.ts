// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserRecorder, MicrophoneError } from "./recorder.js";

/** Browser pieces replaced by fakes that count what is opened and what is given back. */
class FakeTrack {
  readonly stop = vi.fn();
}
class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

interface Behaviour {
  recorderThrows?: boolean;
  contextThrows?: boolean;
}

const streams: FakeStream[] = [];
const recorders: FakeMediaRecorder[] = [];
const contexts: FakeAudioContext[] = [];
let behaviour: Behaviour = {};
let grant: (() => Promise<FakeStream>) | undefined;

class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: FakeStream) {
    if (behaviour.recorderThrows === true) {
      throw new Error("MediaRecorder is not supported here");
    }
    recorders.push(this);
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    this.onstop?.();
  }
}

class FakeAudioContext {
  readonly close = vi.fn(() => Promise.resolve());
  constructor() {
    if (behaviour.contextThrows === true) {
      throw new Error("No audio context");
    }
    contexts.push(this);
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData: () => undefined };
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
}

const open = (): FakeStream | undefined =>
  streams.find((stream) => stream.track.stop.mock.calls.length === 0);

beforeEach(() => {
  behaviour = {};
  grant = undefined;
  streams.length = 0;
  recorders.length = 0;
  contexts.length = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => {
        if (grant !== undefined) {
          return grant();
        }
        const stream = new FakeStream();
        streams.push(stream);
        return Promise.resolve(stream);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("AC-027.3: the browser recorder gives the microphone back", () => {
  it("opens the microphone and starts recording", async () => {
    const recorder = createBrowserRecorder();
    await recorder.start(() => undefined);
    expect(streams).toHaveLength(1);
    expect(recorders[0]?.state).toBe("recording");
    expect(open()).toBe(streams[0]);
    recorder.cancel();
    expect(streams[0]?.track.stop).toHaveBeenCalledTimes(1);
    expect(recorders[0]?.state).toBe("inactive");
    expect(contexts[0]?.close).toHaveBeenCalled();
  });

  it("stops the granted microphone when MediaRecorder cannot be built, and Try again works", async () => {
    const recorder = createBrowserRecorder();
    behaviour = { recorderThrows: true };
    await expect(recorder.start(() => undefined)).rejects.toThrow(/not supported/);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.track.stop).toHaveBeenCalledTimes(1);

    behaviour = {};
    await recorder.start(() => undefined);
    expect(streams).toHaveLength(2);
    expect(streams[1]?.track.stop).not.toHaveBeenCalled();
    expect(recorders[0]?.state).toBe("recording");
    recorder.cancel();
    expect(streams[1]?.track.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the microphone and the recorder when the audio context cannot be built", async () => {
    const recorder = createBrowserRecorder();
    behaviour = { contextThrows: true };
    await expect(recorder.start(() => undefined)).rejects.toThrow(/No audio context/);
    expect(streams[0]?.track.stop).toHaveBeenCalledTimes(1);
    expect(recorders[0]?.state).toBe("inactive");
  });

  it("a second start releases whatever the first one still held", async () => {
    const recorder = createBrowserRecorder();
    await recorder.start(() => undefined);
    await recorder.start(() => undefined);
    expect(streams[0]?.track.stop).toHaveBeenCalledTimes(1);
    expect(streams[1]?.track.stop).not.toHaveBeenCalled();
    expect(recorders[0]?.state).toBe("inactive");
    expect(recorders[1]?.state).toBe("recording");
    recorder.cancel();
  });

  it("a recorder error settles a pending stop and releases the microphone", async () => {
    const recorder = createBrowserRecorder();
    await recorder.start(() => undefined);
    const active = recorders[0]!;
    // The recorder fails while the stop is pending: its stop() never reaches onstop.
    active.stop = () => undefined;
    const pending = recorder.stop();
    active.onerror?.();
    await expect(pending).rejects.toThrow(/recording failed/);
    expect(streams[0]?.track.stop).toHaveBeenCalledTimes(1);
  });

  it("cancelling while a stop is pending rejects it instead of hanging", async () => {
    const recorder = createBrowserRecorder();
    await recorder.start(() => undefined);
    recorders[0]!.stop = () => undefined;
    const pending = recorder.stop();
    recorder.cancel();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(streams[0]?.track.stop).toHaveBeenCalledTimes(1);
  });

  it("gives back a microphone granted after the start was cancelled", async () => {
    const late = new FakeStream();
    streams.push(late);
    let resolveGrant: (stream: FakeStream) => void = () => undefined;
    grant = () =>
      new Promise<FakeStream>((resolve) => {
        resolveGrant = resolve;
      });
    const recorder = createBrowserRecorder();
    const started = recorder.start(() => undefined);
    recorder.cancel();
    resolveGrant(late);
    await started;
    expect(late.track.stop).toHaveBeenCalledTimes(1);
    expect(recorders).toHaveLength(0);
  });

  it("reports a refused microphone as a MicrophoneError", async () => {
    grant = () => Promise.reject(new Error("NotAllowedError"));
    await expect(createBrowserRecorder().start(() => undefined)).rejects.toBeInstanceOf(
      MicrophoneError,
    );
  });

  it("stop() without a recording is an error, not a hang", async () => {
    await expect(createBrowserRecorder().stop()).rejects.toThrow(/Not recording/);
  });
});
