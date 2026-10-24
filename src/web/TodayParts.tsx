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

/**
 * "Gemma 4 E4B" from the Ollama tag the app is configured with (`gemma4:e4b`); a tag that is not
 * in that shape is shown as it is, so the line never claims a model it does not know.
 */
export function gemmaDisplayName(tag: string): string {
  const found = /^gemma[-_]?(\d+)(?::(.+))?$/i.exec(tag.trim());
  if (found?.[1] === undefined) {
    return tag;
  }
  return found[2] === undefined
    ? `Gemma ${found[1]}`
    : `Gemma ${found[1]} ${found[2].toUpperCase()}`;
}

/** The words of the status line: the model and where it runs, or the fake and offline states. */
export function gemmaStatusText(gemma: Today["gemma"], mode: "home" | "hosted" = "home"): string {
  if (gemma.status === "online" && gemma.detail !== null && gemma.detail !== "fake model") {
    // Hosted mode says where Gemma runs and which model answers (AC-032.6).
    return mode === "hosted"
      ? `Gemma 4 · DigitalOcean · ${gemma.detail}`
      : `${gemmaDisplayName(gemma.detail)} · on this laptop`;
  }
  return `${GEMMA_STATUS_TEXT[gemma.status]}${gemma.detail === "fake model" ? " (fake model)" : ""}`;
}

/**
 * Gemma's status on Today (AC-013.5): one quiet line with a dot, announced when it changes. It
 * names the model and says it runs on this laptop (design.md Round 3, item 17); the fake model
 * and the offline state read as they did.
 */
export function GemmaStatus({
  gemma,
  mode = "home",
}: {
  gemma: Today["gemma"];
  mode?: "home" | "hosted";
}) {
  return (
    <>
      <p className={`gemma-status ${gemma.status}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        {gemmaStatusText(gemma, mode)}
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
 * with the rank, and Gemma's status. The h1 names the screen for screen readers and takes the
 * focus after a route change; the greeting is the visible headline.
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
        Today
      </h1>
      <div className="today-hello">
        <p className="eyebrow">{formatDateLine(now)}</p>
        <p className="greeting">{greetingFor(now)}</p>
        {today === undefined ? null : (
          <GemmaStatus gemma={today.gemma} mode={today.mode ?? "home"} />
        )}
      </div>
      {today === undefined ? null : (
        <p className="points">
          <Icon name="trophy" />
          <span className="points-text">
            {formatTotal(today.points.total)}{" "}
            {rankName === undefined ? (
              "pts"
            ) : (
              <>
                <span className="sr-only">points, </span>
                {rankName}
              </>
            )}
          </span>
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
