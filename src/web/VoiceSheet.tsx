import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import {
  ApiError,
  confirmVoiceChores,
  transcribeVoiceNote,
  type Card,
  type VoicePreview,
} from "./api.js";
import { usePrefersReducedMotion } from "./motion.js";
import { ChoreTile } from "./ui/ChoreTile.js";
import { highlightSegments, type ChoreKind } from "./voice/highlight.js";
import { MicrophoneError, type VoiceRecorder } from "./voice/recorder.js";
import { MAX_RECORD_SECONDS } from "./voice/wav-encoder.js";

import "./voice/voice.css";

/** The two calls of the flow; tests swap them, the app uses the real ones. */
export interface VoiceApi {
  /** Sends the note; the answer is a transcript with chores, and no card exists yet (AC-027.1). */
  readonly transcribe: (wav: Blob) => Promise<VoicePreview>;
  /** The person confirmed: the cards are made through the typed-capture path. */
  readonly confirm: (chores: VoicePreview["chores"]) => Promise<Card[]>;
}

export const realVoiceApi: VoiceApi = {
  transcribe: transcribeVoiceNote,
  confirm: confirmVoiceChores,
};

export interface VoiceSheetProps {
  readonly recorder: VoiceRecorder;
  readonly api: VoiceApi;
  /** Cards were made (after the confirmation); the sheet closes itself next. */
  readonly onCards: (cards: Card[]) => void;
  readonly onClose: () => void;
}

type Stage =
  | { readonly name: "starting" }
  | { readonly name: "listening" }
  | { readonly name: "hearing" }
  | { readonly name: "review"; readonly preview: VoicePreview }
  | { readonly name: "making"; readonly preview: VoicePreview }
  | { readonly name: "error"; readonly message: string };

const BARS = 28;
const LEVEL_EVERY_MS = 90;
/** Speech is quiet on a 0-1 scale; this makes ordinary talking fill most of the meter. */
const LEVEL_GAIN = 7;

/** What the list says about a chore; the odds come on the card, once it is made. */
const KIND_NOTE: Readonly<Record<ChoreKind, string>> = {
  weather: "Gets odds",
  coming_later: "No bet yet",
  not_weather: "Not a weather chore",
};

/** Chores that get odds or a notice about weather (the mockup counts all but the grey one). */
export function weatherChoreCount(chores: VoicePreview["chores"]): number {
  return chores.filter((chore) => chore.kind !== "not_weather").length;
}

/** The primary button's text (mockup 03): "See odds for 3 chores". */
export function confirmLabel(chores: VoicePreview["chores"]): string {
  const count = weatherChoreCount(chores);
  if (count === 0) {
    return "Add to my list";
  }
  return `See odds for ${count} ${count === 1 ? "chore" : "chores"}`;
}

function describeFailure(error: unknown): string {
  if (error instanceof MicrophoneError) {
    return "The microphone is blocked. Allow it for this site in the browser settings, or type your chores.";
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Something went wrong. Try again, or type your chores.";
}

function Meter({ levels, reduced }: { levels: readonly number[]; reduced: boolean }) {
  return (
    <div className={`voice-meter${reduced ? " still" : ""}`} aria-hidden="true">
      {levels.map((level, index) => (
        <span
          key={index}
          className="voice-bar"
          // Reduced motion: a flat row, no bar moves (WCAG 2.3.3).
          style={{ height: `${reduced ? 20 : 8 + Math.min(1, level * LEVEL_GAIN) * 72}%` }}
        />
      ))}
    </div>
  );
}

function Transcript({ preview }: { preview: VoicePreview }) {
  const segments = highlightSegments(preview.transcript, preview.chores);
  return (
    <blockquote className="voice-transcript">
      {"“"}
      {segments.map((segment, index) =>
        segment.kind === undefined ? (
          <span key={index}>{segment.text}</span>
        ) : (
          // Green for chores the weather decides, grey for the others (mockup 03); the list
          // below says the same in words, so colour is never the only signal.
          <mark
            key={index}
            className={segment.kind === "not_weather" ? "voice-other" : "voice-weather"}
          >
            {segment.text}
          </mark>
        ),
      )}
      {"”"}
    </blockquote>
  );
}

function ChoreList({ chores }: { chores: VoicePreview["chores"] }) {
  return (
    <ul className="voice-chores" aria-label="What Gemma found">
      {chores.map((chore, index) => (
        <li key={index} className={`voice-chore ${chore.kind}`}>
          <ChoreTile title={chore.label} choreType={chore.chore_type} />
          <span className="voice-chore-label">{chore.label}</span>
          <span className="voice-chore-note">{KIND_NOTE[chore.kind]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Mockup 03: the bottom sheet over Today. It listens (level meter, "Listening · Gemma on
 * device"), sends the note to the laptop, shows what Gemma heard with the weather chores
 * highlighted, and only the primary button "See odds for N chores" makes the cards (AC-027.1).
 */
export function VoiceSheet({ recorder, api, onCards, onClose }: VoiceSheetProps) {
  const reduced = usePrefersReducedMotion();
  const [stage, setStage] = useState<Stage>({ name: "starting" });
  const [levels, setLevels] = useState<readonly number[]>(() => Array<number>(BARS).fill(0));
  const [seconds, setSeconds] = useState(0);
  const sheet = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  /** Counts starts, so the answer of a superseded one (React runs effects twice in dev) is ignored. */
  const attempt = useRef(0);
  const lastLevelAt = useRef(0);

  const close = useCallback(() => {
    alive.current = false;
    recorder.cancel();
    onClose();
  }, [recorder, onClose]);

  const begin = useCallback(async () => {
    attempt.current += 1;
    const mine = attempt.current;
    const current = (): boolean => alive.current && attempt.current === mine;
    setStage({ name: "starting" });
    setSeconds(0);
    setLevels(Array<number>(BARS).fill(0));
    try {
      await recorder.start((level) => {
        const now = Date.now();
        if (current() && now - lastLevelAt.current >= LEVEL_EVERY_MS) {
          lastLevelAt.current = now;
          setLevels((previous) => [...previous.slice(1), level]);
        }
      });
      if (current()) {
        setStage({ name: "listening" });
      }
    } catch (error) {
      if (current()) {
        setStage({ name: "error", message: describeFailure(error) });
      }
    }
  }, [recorder]);

  const finish = useCallback(async () => {
    setStage({ name: "hearing" });
    try {
      const wav = await recorder.stop();
      const preview = await api.transcribe(wav);
      if (alive.current) {
        setStage({ name: "review", preview });
      }
    } catch (error) {
      if (alive.current) {
        setStage({ name: "error", message: describeFailure(error) });
      }
    }
  }, [recorder, api]);

  const confirm = async (preview: VoicePreview): Promise<void> => {
    setStage({ name: "making", preview });
    try {
      const cards = await api.confirm(preview.chores);
      if (alive.current) {
        onCards(cards);
        close();
      }
    } catch (error) {
      if (alive.current) {
        setStage({ name: "error", message: describeFailure(error) });
      }
    }
  };

  // Start listening when the sheet opens: the tap on the mic button is the gesture the browser wants.
  useEffect(() => {
    alive.current = true;
    void begin();
    heading.current?.focus();
    return () => {
      alive.current = false;
      recorder.cancel();
    };
  }, [begin, recorder]);

  // The note is a sentence or two: stop by itself after MAX_RECORD_SECONDS.
  const listening = stage.name === "listening";
  useEffect(() => {
    if (!listening) {
      return undefined;
    }
    const timer = setInterval(() => {
      setSeconds((value) => value + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [listening]);
  useEffect(() => {
    if (listening && seconds >= MAX_RECORD_SECONDS) {
      void finish();
    }
  }, [listening, seconds, finish]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || sheet.current === null) {
      return;
    }
    // Keep Tab inside the sheet while it is open (it is modal).
    const focusable = [
      ...sheet.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='-1']"),
    ].filter((element) => element.tabIndex >= -1);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const status =
    stage.name === "listening" || stage.name === "starting"
      ? "Listening · Gemma on device"
      : stage.name === "hearing"
        ? "Gemma is writing it down…"
        : stage.name === "making"
          ? "Making your slips…"
          : stage.name === "review"
            ? "Here is what Gemma heard"
            : "Voice capture";

  return createPortal(
    <div className="voice-scrim" onKeyDown={onKeyDown}>
      <div
        ref={sheet}
        className="voice-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-title"
      >
        <span className="voice-grabber" aria-hidden="true" />
        <h2 id="voice-title" ref={heading} tabIndex={-1} className="voice-status">
          {stage.name === "listening" || stage.name === "starting" ? (
            <span className="voice-dot" aria-hidden="true" />
          ) : null}
          {status}
        </h2>

        {stage.name === "starting" ? (
          <p className="meta" role="status">
            Allow the microphone when your browser asks.
          </p>
        ) : null}

        {stage.name === "listening" ? (
          <>
            <Meter levels={levels} reduced={reduced} />
            <p className="meta voice-time" role="status">
              {reduced ? "Recording. " : ""}
              {seconds} s of {MAX_RECORD_SECONDS} s. Say your chores in one go.
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                void finish();
              }}
            >
              Done
            </button>
          </>
        ) : null}

        {stage.name === "hearing" ? (
          <p className="meta" role="status">
            Your voice stays on the laptop. This takes a few seconds.
          </p>
        ) : null}

        {stage.name === "review" || stage.name === "making" ? (
          <>
            <Transcript preview={stage.preview} />
            <ChoreList chores={stage.preview.chores} />
            <button
              type="button"
              className="button primary"
              disabled={stage.name === "making"}
              onClick={() => {
                void confirm(stage.preview);
              }}
            >
              {confirmLabel(stage.preview.chores)}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={stage.name === "making"}
              onClick={() => {
                void begin();
              }}
            >
              Record again
            </button>
          </>
        ) : null}

        {stage.name === "error" ? (
          <>
            <p className="voice-error" role="alert">
              {stage.message}
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                void begin();
              }}
            >
              Try again
            </button>
          </>
        ) : null}

        <button type="button" className="button secondary" onClick={close}>
          {stage.name === "error" ? "Type instead" : "Cancel"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
