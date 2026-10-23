import { useState, type FormEvent, type ReactNode } from "react";

import type { Today } from "./api.js";
import { formatDateLine, formatTotal, greetingFor } from "./format.js";
import { choreIconName, Icon } from "./ui/Icon.js";
import "./today.css";

/** The longest sentence the listener reads (AC-002.1). */
const MAX_CAPTURE_CHARS = 500;

const GEMMA_STATUS_TEXT = {
  online: "Gemma is online",
  waking: "Gemma is waking up",
  offline: "Gemma is offline, rule odds only",
} as const;

/** Gemma's status on Today (AC-013.5): one quiet line with a dot, announced when it changes. */
export function GemmaStatus({ gemma }: { gemma: Today["gemma"] }) {
  return (
    <>
      <p className={`gemma-status ${gemma.status}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        {GEMMA_STATUS_TEXT[gemma.status]}
        {gemma.detail === "fake model" ? " (fake model)" : ""}
      </p>
      {gemma.warning === undefined ? null : (
        <p className="gemma-status offline" role="status">
          <span className="status-dot" aria-hidden="true" />
          {gemma.warning}
        </p>
      )}
    </>
  );
}

/**
 * The header of Today (mockup 02): the date, a greeting by Madrid time of day, the points chip
 * with the rank, and Gemma's status. The h1 is the app's name for screen readers and for the focus
 * move after a route change; the greeting is the visible headline.
 */
export function TodayHeader({
  today,
  rankName,
}: {
  readonly today: Today | undefined;
  /** The rank for the points total (flag `ranks`); the chip says "pts" without it. */
  readonly rankName?: string | undefined;
}) {
  // Before the first answer the greeting follows the device clock; the server's takes over.
  const now = today?.now ?? new Date().toISOString();
  return (
    <header className="today-header">
      <h1 className="sr-only" tabIndex={-1}>
        The Lazy Bookie
      </h1>
      <div className="today-hello">
        <p className="eyebrow">{formatDateLine(now)}</p>
        <p className="greeting">{greetingFor(now)}</p>
        {today === undefined ? null : <GemmaStatus gemma={today.gemma} />}
      </div>
      {today === undefined ? null : (
        <p className="points">
          <Icon name="trophy" />
          {formatTotal(today.points.total)}{" "}
          {rankName === undefined ? (
            "pts"
          ) : (
            <>
              <span className="sr-only">points, </span>
              {rankName}
            </>
          )}
        </p>
      )}
    </header>
  );
}

/**
 * The capture bar (mockup 02): one row with the typed sentence and its submit button (Enter
 * submits too), and the voice control after it. `micSlot` is where the voice capture button goes
 * (flag `voice`, only while the microphone is available, AC-027.3); it stays outside the form, as
 * the sheet it opens is not part of the typed sentence. Without it no mic is shown.
 */
export function CaptureBar({
  busy,
  onCapture,
  micSlot,
}: {
  readonly busy: boolean;
  readonly onCapture: (text: string) => Promise<boolean>;
  readonly micSlot?: ReactNode;
}) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const sentence = text.trim();
    if (sentence === "") {
      return;
    }
    // The text stays in the box unless the cards were made, so a failed read can be rephrased.
    void onCapture(sentence).then((made) => {
      if (made) {
        setText("");
      }
    });
  };
  return (
    <div className="capture-bar">
      <form className="capture-form" onSubmit={submit}>
        <label htmlFor="capture-text" className="sr-only">
          Or type your chores in one sentence
        </label>
        <input
          id="capture-text"
          type="text"
          value={text}
          maxLength={MAX_CAPTURE_CHARS}
          placeholder="What's on your list today?"
          autoComplete="off"
          enterKeyHint="send"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <button
          type="submit"
          className="capture-send"
          aria-label="Get odds"
          disabled={busy || text.trim() === ""}
        >
          <Icon name="arrow" />
        </button>
      </form>
      {micSlot}
    </div>
  );
}

export interface ChipSpec {
  readonly choreType: string;
  readonly label: string;
}

/** The quick chips under the capture bar: one scrolling row (mockup 02). */
export function QuickChips({
  chips,
  busy,
  onPick,
}: {
  readonly chips: readonly ChipSpec[];
  readonly busy: boolean;
  readonly onPick: (choreType: string) => void;
}) {
  return (
    <div className="chip-row" role="group" aria-label="Quick chores">
      {chips.map((chip) => (
        <button
          key={chip.choreType}
          type="button"
          className="chip"
          disabled={busy}
          onClick={() => {
            onPick(chip.choreType);
          }}
        >
          <Icon name={choreIconName(chip.label, chip.choreType)} />
          {chip.label}
        </button>
      ))}
    </div>
  );
}
