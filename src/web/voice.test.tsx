// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Card, Today, VoicePreview } from "./api.js";
import { emptyWeek } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";
import { VoiceCapture } from "./VoiceCapture.js";
import { confirmLabel, type VoiceApi } from "./VoiceSheet.js";
import { highlightSegments } from "./voice/highlight.js";
import { MicrophoneError, type VoiceRecorder } from "./voice/recorder.js";
import { browserEnvironment, micAvailable, type VoiceEnvironment } from "./voice/support.js";
import { MAX_RECORD_SECONDS } from "./voice/wav-encoder.js";

const READY: VoiceEnvironment = {
  isSecureContext: true,
  mediaDevices: { getUserMedia: () => undefined },
  hasMediaRecorder: true,
};

// Synthetic sentence and chores, as the listener would split them (mockup 03).
const preview: VoicePreview = {
  transcript: "I have to wash the car, do the laundry and water the plants. Oh, and call the bank.",
  chores: [
    { label: "do the laundry", chore_type: "laundry_line", kind: "weather" },
    { label: "water the plants", chore_type: "plants", kind: "weather" },
    { label: "wash the car", chore_type: "other_weather", kind: "coming_later" },
    { label: "call the bank", chore_type: "not_weather", kind: "not_weather" },
  ],
  duration_ms: 6000,
};

class FakeRecorder implements VoiceRecorder {
  started = 0;
  stopped = 0;
  cancelled = 0;
  failWith: Error | undefined;
  start(onLevel: (level: number) => void): Promise<void> {
    this.started += 1;
    onLevel(0.05);
    return this.failWith === undefined ? Promise.resolve() : Promise.reject(this.failWith);
  }
  stop(): Promise<Blob> {
    this.stopped += 1;
    return Promise.resolve(new Blob(["synthetic wav"], { type: "audio/wav" }));
  }
  cancel(): void {
    this.cancelled += 1;
  }
}

function fakeApi(override: Partial<VoiceApi> = {}) {
  const transcribe = vi.fn<VoiceApi["transcribe"]>(() => Promise.resolve(preview));
  const confirm = vi.fn<VoiceApi["confirm"]>(() => Promise.resolve([] as Card[]));
  return { api: { transcribe, confirm, ...override } satisfies VoiceApi, transcribe, confirm };
}

describe("AC-027.3: the mic is hidden when the browser cannot record", () => {
  it("is available only with a secure context, getUserMedia and MediaRecorder", () => {
    expect(micAvailable(READY)).toBe(true);
    expect(micAvailable({ ...READY, isSecureContext: false })).toBe(false);
    expect(micAvailable({ ...READY, mediaDevices: undefined })).toBe(false);
    expect(micAvailable({ ...READY, mediaDevices: {} })).toBe(false);
    expect(micAvailable({ ...READY, hasMediaRecorder: false })).toBe(false);
  });

  it("renders no button over plain HTTP, without media devices or with the flag off", () => {
    const render = (enabled: boolean, environment: VoiceEnvironment) =>
      renderToStaticMarkup(
        <VoiceCapture enabled={enabled} onCards={() => undefined} environment={environment} />,
      );
    expect(render(true, READY)).toContain("Say your chores");
    expect(render(true, { ...READY, isSecureContext: false })).toBe("");
    expect(render(true, { ...READY, mediaDevices: undefined })).toBe("");
    expect(render(false, READY)).toBe("");
  });

  describe("on Today", () => {
    const today: Today = {
      now: "2026-10-22T08:00:00.000Z",
      flags: { voice: true },
      points: { total: 0 },
      gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
      forecast: null,
      week: emptyWeek,
      attribution: "Weather data by Open-Meteo.com",
      cards: [],
      open_bets: [],
      due_bets: [],
    };
    const screen = (value: Today) =>
      renderToStaticMarkup(
        <TodayScreen
          today={value}
          busy={false}
          notice={undefined}
          results={{}}
          nowMs={Date.parse(value.now)}
          onQuickCard={() => undefined}
          onCapture={() => Promise.resolve(true)}
          onVoiceCards={() => undefined}
          onRetry={() => undefined}
          onAnswer={() => undefined}
          onBet={() => undefined}
          onDoIt={() => undefined}
          onUndo={() => undefined}
          onSettle={() => undefined}
        />,
      );

    afterEach(() => {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(navigator, "mediaDevices");
      Reflect.deleteProperty(window, "isSecureContext");
    });

    it("keeps typed capture and shows no mic where the browser has no microphone API (plain HTTP)", () => {
      expect(browserEnvironment().mediaDevices).toBeUndefined();
      const html = screen(today);
      expect(html).not.toContain("Say your chores");
      expect(html).toContain("Or type your chores in one sentence");
      expect(html).toContain('id="capture-text"');
      expect(html).toContain("Get odds");
    });

    it("shows the mic next to typed capture on a secure page with a microphone", () => {
      vi.stubGlobal("MediaRecorder", class {});
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: () => undefined },
        configurable: true,
      });
      const html = screen(today);
      expect(html).toContain("Say your chores");
      expect(html).toContain('id="capture-text"');
      // The flag off hides it again, whatever the browser offers.
      expect(screen({ ...today, flags: { voice: false } })).not.toContain("Say your chores");
    });

    it("shows the mic only when the page can act on its cards", () => {
      vi.stubGlobal("MediaRecorder", class {});
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: () => undefined },
        configurable: true,
      });
      const html = renderToStaticMarkup(
        <TodayScreen
          today={today}
          busy={false}
          notice={undefined}
          results={{}}
          nowMs={Date.parse(today.now)}
          onQuickCard={() => undefined}
          onCapture={() => Promise.resolve(true)}
          onRetry={() => undefined}
          onAnswer={() => undefined}
          onBet={() => undefined}
          onDoIt={() => undefined}
          onUndo={() => undefined}
          onSettle={() => undefined}
        />,
      );
      expect(html).not.toContain("Say your chores");
    });
  });
});

describe("the highlighted transcript", () => {
  it("marks each chore where it was said, and leaves the other words plain", () => {
    expect(highlightSegments(preview.transcript, preview.chores)).toEqual([
      { text: "I have to " },
      { text: "wash the car", kind: "coming_later" },
      { text: ", " },
      { text: "do the laundry", kind: "weather" },
      { text: " and " },
      { text: "water the plants", kind: "weather" },
      { text: ". Oh, and " },
      { text: "call the bank", kind: "not_weather" },
      { text: "." },
    ]);
  });

  it("matches ignoring case, falls back to the item, and skips a chore that was paraphrased", () => {
    expect(
      highlightSegments("Water the TOMATOES, please", [
        { label: "watering", item: "tomatoes", kind: "weather" },
        { label: "mow the lawn", kind: "coming_later" },
      ]),
    ).toEqual([
      { text: "Water the " },
      { text: "TOMATOES", kind: "weather" },
      { text: ", please" },
    ]);
  });

  it("does not mark the same words twice for two chores with the same label", () => {
    const segments = highlightSegments("water the plants", [
      { label: "water the plants", kind: "weather" },
      { label: "water the plants", kind: "weather" },
    ]);
    expect(segments).toEqual([{ text: "water the plants", kind: "weather" }]);
  });

  it("words the primary button as in the mockup, counting the chores that are not grey", () => {
    expect(confirmLabel(preview.chores)).toBe("See odds for 3 chores");
    expect(confirmLabel(preview.chores.slice(0, 1))).toBe("See odds for 1 chore");
    expect(confirmLabel(preview.chores.slice(3))).toBe("Add to my list");
  });
});

describe("AC-027.1: the sheet shows the transcript before any card, and cards follow the confirmation", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(recorder: VoiceRecorder, api: VoiceApi, onCards = vi.fn()) {
    act(() => {
      root.render(
        <VoiceCapture
          enabled
          environment={READY}
          createRecorder={() => recorder}
          api={api}
          onCards={onCards}
        />,
      );
    });
    return onCards;
  }
  const click = async (name: RegExp): Promise<void> => {
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      name.test(candidate.textContent),
    );
    if (button === undefined) {
      throw new Error(`No button ${String(name)}`);
    }
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  };
  const sheetText = (): string => document.querySelector(".voice-sheet")?.textContent ?? "";

  it("listens, sends the note, and shows the transcript with the chores highlighted; no card yet", async () => {
    const recorder = new FakeRecorder();
    const { api, transcribe, confirm } = fakeApi();
    const onCards = mount(recorder, api);
    expect(document.querySelector(".voice-sheet")).toBeNull();

    await click(/Say your chores/);
    expect(recorder.started).toBe(1);
    expect(sheetText()).toContain("Listening · Gemma on device");
    expect(document.querySelector(".voice-sheet")?.getAttribute("role")).toBe("dialog");

    await click(/^Done$/);
    expect(recorder.stopped).toBe(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]?.[0]).toBeInstanceOf(Blob);

    const marks = [...document.querySelectorAll(".voice-transcript mark")].map((mark) => [
      mark.textContent,
      mark.className,
    ]);
    expect(marks).toEqual([
      ["wash the car", "voice-weather"],
      ["do the laundry", "voice-weather"],
      ["water the plants", "voice-weather"],
      ["call the bank", "voice-other"],
    ]);
    // The parsed list says it in words, and the primary button counts the chores.
    expect([...document.querySelectorAll(".voice-chore")].map((row) => row.textContent)).toEqual([
      "do the laundryGets odds",
      "water the plantsGets odds",
      "wash the carNo bet yet",
      "call the bankNot a weather chore",
    ]);
    expect(sheetText()).toContain("See odds for 3 chores");
    // Nothing was created: the confirmation has not happened.
    expect(confirm).not.toHaveBeenCalled();
    expect(onCards).not.toHaveBeenCalled();
  });

  it("makes the cards only when the person presses 'See odds', with the listed chores, then closes", async () => {
    const recorder = new FakeRecorder();
    const cards = [{ id: 1 }] as Card[];
    const confirm = vi.fn<VoiceApi["confirm"]>(() => Promise.resolve(cards));
    const { api } = fakeApi({ confirm });
    const onCards = mount(recorder, api);
    await click(/Say your chores/);
    await click(/^Done$/);
    expect(confirm).not.toHaveBeenCalled();

    await click(/See odds for 3 chores/);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(preview.chores);
    expect(onCards).toHaveBeenCalledWith(cards);
    expect(document.querySelector(".voice-sheet")).toBeNull();
  });

  it("makes no card when the person cancels or records again", async () => {
    const recorder = new FakeRecorder();
    const { api, confirm, transcribe } = fakeApi();
    const onCards = mount(recorder, api);
    await click(/Say your chores/);
    await click(/^Done$/);
    await click(/Record again/);
    expect(recorder.started).toBe(2);
    expect(sheetText()).toContain("Listening · Gemma on device");
    await click(/^Cancel$/);
    expect(document.querySelector(".voice-sheet")).toBeNull();
    expect(recorder.cancelled).toBeGreaterThanOrEqual(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(onCards).not.toHaveBeenCalled();
  });

  it("closes on Escape and stops the microphone", async () => {
    const recorder = new FakeRecorder();
    mount(recorder, fakeApi().api);
    await click(/Say your chores/);
    await act(async () => {
      document
        .querySelector(".voice-scrim")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector(".voice-sheet")).toBeNull();
    expect(recorder.cancelled).toBeGreaterThanOrEqual(1);
  });

  it("stops by itself after the longest note and sends what it has", async () => {
    vi.useFakeTimers();
    const recorder = new FakeRecorder();
    const { api, transcribe } = fakeApi();
    mount(recorder, api);
    await click(/Say your chores/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_RECORD_SECONDS * 1000 + 100);
    });
    expect(recorder.stopped).toBe(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("explains a blocked microphone and offers typing instead", async () => {
    const recorder = new FakeRecorder();
    recorder.failWith = new MicrophoneError("blocked");
    const { api, transcribe } = fakeApi();
    mount(recorder, api);
    await click(/Say your chores/);
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "The microphone is blocked",
    );
    expect(transcribe).not.toHaveBeenCalled();
    await click(/Type instead/);
    expect(document.querySelector(".voice-sheet")).toBeNull();
  });

  it("shows the server's reason when Gemma could not make the note out", async () => {
    const { ApiError } = await import("./api.js");
    const { api } = fakeApi({
      transcribe: vi.fn(() =>
        Promise.reject(new ApiError(422, "Gemma couldn't make that out: Try again, or type it.")),
      ),
    });
    mount(new FakeRecorder(), api);
    await click(/Say your chores/);
    await click(/^Done$/);
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "Gemma couldn't make that out",
    );
    expect(sheetText()).toContain("Try again");
  });

  it("draws a flat, still meter when reduced motion is preferred", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    mount(new FakeRecorder(), fakeApi().api);
    await click(/Say your chores/);
    const meter = document.querySelector(".voice-meter");
    expect(meter?.classList.contains("still")).toBe(true);
    const heights = new Set(
      [...document.querySelectorAll<HTMLElement>(".voice-bar")].map((bar) => bar.style.height),
    );
    expect(heights.size).toBe(1);
  });

  it("has no accessibility violations while listening, reviewing or on an error", async () => {
    document.documentElement.lang = "en";
    document.title = "Today · Should I Bother?";
    const recorder = new FakeRecorder();
    mount(recorder, fakeApi().api);
    const violations = async (): Promise<string[]> =>
      (
        await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } })
      ).violations.map((violation) => `${violation.id}: ${violation.help}`);
    await click(/Say your chores/);
    expect(await violations()).toEqual([]);
    await click(/^Done$/);
    expect(await violations()).toEqual([]);
    await click(/Record again/);
    recorder.failWith = new MicrophoneError("blocked");
    await click(/^Cancel$/);
    await click(/Say your chores/);
    expect(await violations()).toEqual([]);
  });
});
