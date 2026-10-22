import type { Bet } from "./api.js";
import { formatOdds, formatPoints, formatSettleTime, formatTimeLeft } from "./format.js";

/** Titles of the judge's verdicts, for a settled bet (AC-007.1) and the settle receipt. */
export const VERDICT_TITLES: Readonly<Record<string, string>> = {
  win: "You win",
  small_loss: "Small loss",
  normal_loss: "Loss",
  harmful_loss: "Harmful loss",
  weather_would_not: "Weather would not have helped",
  weather_would_have: "Weather would have done it",
};

/** Plain words for the steps of the state machine after the settle time (AC-008.8). */
const WAITING_STATUS_TEXT: Readonly<Record<string, string>> = {
  awaiting_weather: "Waiting for the recorded weather",
  awaiting_gemma: "Settle when Gemma is back",
};

export function statusText(status: string): string | undefined {
  return WAITING_STATUS_TEXT[status];
}

export function betKindLabel(bet: Pick<Bet, "kind">): string {
  return bet.kind === "do_it" ? "I'll do it" : "Bet: do nothing";
}

/** Whether Undo is still offered: the server says so, and the countdown has not run out here. */
export function undoMinutesLeft(bet: Bet, nowMs: number): number | undefined {
  const left = Date.parse(bet.undo_until) - nowMs;
  if (!bet.undoable || left < 0) {
    return undefined;
  }
  return Math.max(1, Math.ceil(left / 60_000));
}

export function UndoButton({
  bet,
  nowMs,
  busy,
  onUndo,
}: {
  bet: Bet;
  nowMs: number;
  busy: boolean;
  onUndo: (betId: number) => void;
}) {
  const minutes = undoMinutesLeft(bet, nowMs);
  if (minutes === undefined) {
    return null;
  }
  return (
    <button
      type="button"
      className="button secondary compact"
      disabled={busy}
      onClick={() => {
        onUndo(bet.id);
      }}
    >
      Undo ({minutes} min left)
    </button>
  );
}

/** One waiting bet: what it is, its odds, the countdown to its settle time and Undo while open. */
export function WaitingLine({
  bet,
  nowMs,
  busy,
  onUndo,
}: {
  bet: Bet;
  nowMs: number;
  busy: boolean;
  onUndo: (betId: number) => void;
}) {
  return (
    <li>
      <div className="line-main">
        <span className="line-title">
          {bet.title} · {betKindLabel(bet)}
        </span>
        <span className="meta">
          {formatOdds(bet.band_name, bet.odds)} · settles {formatSettleTime(bet.settle_at)}
        </span>
        <span className="meta countdown">
          {formatTimeLeft(Date.parse(bet.settle_at) - nowMs)} left
        </span>
      </div>
      <UndoButton bet={bet} nowMs={nowMs} busy={busy} onUndo={onUndo} />
    </li>
  );
}

/**
 * A bet whose settle time has come. A bet on doing nothing asks for the one-tap answer; a do-it
 * decision has no question, the judge decides from the recorded weather (AC-008.9, T-009).
 */
export function DueSlip({
  bet,
  busy,
  onSettle,
}: {
  bet: Bet;
  busy: boolean;
  onSettle: (betId: number, answerId: string) => void;
}) {
  const waitingText = statusText(bet.status);
  const asksForAnswer =
    bet.kind === "do_nothing" && (bet.status === "open" || bet.status === "due");
  return (
    <article className="slip due" aria-label={`${bet.title}, ready to settle`}>
      <p className="eyebrow">
        Settle now · {betKindLabel(bet)} at {formatOdds(bet.band_name, bet.odds)}
      </p>
      <h3>{bet.title}</h3>
      {asksForAnswer ? (
        <>
          <p className="question">How did it turn out?</p>
          <div className="answers">
            {bet.tap_answers.map((answer) => (
              <button
                key={answer.id}
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  onSettle(bet.id, answer.id);
                }}
              >
                {answer.label}
              </button>
            ))}
          </div>
          <p className="meta">One tap pays half of a win; losses cost the same either way.</p>
        </>
      ) : (
        <p className="meta">
          {waitingText ??
            (bet.kind === "do_it"
              ? "You said you would do it. Gemma checks the recorded weather to score it."
              : "Waiting to be settled.")}
        </p>
      )}
    </article>
  );
}

export function SettledLine({
  bet,
}: {
  bet: Bet & { result: { verdict: string; points: number; evidence: string } };
}) {
  return (
    <li>
      <div className="line-main">
        <span className="line-title">
          {bet.title} · {betKindLabel(bet)}
        </span>
        <span className="meta">
          {formatOdds(bet.band_name, bet.odds)} ·{" "}
          {VERDICT_TITLES[bet.result.verdict] ?? bet.result.verdict}
        </span>
      </div>
      <span className="line-points">{formatPoints(bet.result.points)}</span>
    </li>
  );
}
