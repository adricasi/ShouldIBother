import type { Bet, Receipt } from "./api.js";
import { AppealAction } from "./AppealParts.js";
import { HowGemmaDecided, OddsWho } from "./GemmaParts.js";
import { PhotoPicker } from "./PhotoParts.js";
import { RescuePanel } from "./RescueParts.js";
import { ReceiptCard, WeatherLine } from "./SettleParts.js";
import { formatOdds, formatPoints, formatSettleTime, formatTimeLeft } from "./format.js";
import { ChoreTile } from "./ui/ChoreTile.js";
import { choreIconName, Icon } from "./ui/Icon.js";
import { elapsedFraction, ProgressRing } from "./ui/ProgressRing.js";

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
  onCashOut,
}: {
  bet: Bet;
  nowMs: number;
  busy: boolean;
  onUndo: (betId: number) => void;
  /** Where the rescue alert and Cash out are offered (REQ-022); absent: neither is shown. */
  onCashOut?: (betId: number) => void;
}) {
  const settleAtMs = Date.parse(bet.settle_at);
  return (
    <li className="waiting-line">
      <ProgressRing fraction={elapsedFraction(Date.parse(bet.placed_at), settleAtMs, nowMs)}>
        <Icon name={choreIconName(bet.title, bet.chore_type)} />
      </ProgressRing>
      <div className="line-main">
        <span className="line-title">
          {bet.title} · {betKindLabel(bet)}
        </span>
        <span className="meta">
          {formatOdds(bet.band_name, bet.odds)} · settles {formatSettleTime(bet.settle_at)}
        </span>
        <OddsWho source={bet.odds_source} gemma={bet.gemma} rule={bet.rule} />
      </div>
      <p className="countdown">
        <span className="count-figure">{formatTimeLeft(settleAtMs - nowMs)}</span>{" "}
        <span className="count-unit">left</span>
      </p>
      <div className="waiting-foot">
        <UndoButton bet={bet} nowMs={nowMs} busy={busy} onUndo={onUndo} />
        {onCashOut === undefined ? null : (
          <RescuePanel bet={bet} busy={busy} onCashOut={onCashOut} />
        )}
      </div>
    </li>
  );
}

export interface SettleActions {
  readonly onSettle: (betId: number, answerId: string) => void;
  /** Settle with an after photo (full points); absent where photos cannot be sent. */
  readonly onPhoto?: (betId: number, file: File) => void;
  /** Answer the judge's yes/no question (AC-008.5). */
  readonly onAnswer?: (betId: number, yes: boolean) => void;
}

/**
 * A bet whose settle time has come (REQ-008): the recorded weather, then either the one-tap
 * answers and the after photo, the judge's question as two taps, or the words for what the bet
 * waits for (the weather, Gemma, or its 24 h limit). A do-it decision has no question: the judge
 * decides from the recorded weather (AC-008.9).
 */
export function DueSlip({
  bet,
  busy,
  onSettle,
  onPhoto,
  onAnswer,
}: { bet: Bet; busy: boolean } & SettleActions) {
  const settle = bet.settle;
  const fallbackNote = statusText(bet.status) ?? "Waiting to be settled.";
  return (
    <article className="slip due" aria-label={`${bet.title}, ready to settle`}>
      <div className="slip-head">
        <ChoreTile title={bet.title} choreType={bet.chore_type} />
        <div className="line-main">
          <h3>{bet.title}</h3>
          <p className="eyebrow">
            Settle now · {betKindLabel(bet)} at {formatOdds(bet.band_name, bet.odds)}
          </p>
        </div>
        {settle?.state === "answer_needed" || settle?.state === "question" ? (
          <span className="pill ready">Ready</span>
        ) : null}
      </div>
      <OddsWho source={bet.odds_source} gemma={bet.gemma} rule={bet.rule} />
      {settle === null ? null : <WeatherLine weather={settle.weather} />}
      {settle?.state === "answer_needed" ? (
        <>
          <p className="question prompt">How did it turn out?</p>
          <div className="answers row">
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
          {onPhoto === undefined ? null : (
            <PhotoPicker
              label="Add an after photo for full points"
              variant="link"
              busy={busy}
              onPick={(file) => {
                onPhoto(bet.id, file);
              }}
            />
          )}
          <p className="meta">
            A photo pays a win in full, one tap pays half; losses cost the same either way. No
            answer by {formatSettleTime(settle.answer_until)}: Gemma settles it from the weather
            record at half points.
          </p>
          {settle.note === null ? null : <p className="meta">{settle.note}</p>}
        </>
      ) : settle?.state === "question" && settle.question !== null ? (
        <div className="gemma-question">
          <p className="eyebrow">
            <Icon name="sparkle" /> Gemma has a question
          </p>
          <p className="question">{settle.question}</p>
          <div className="answers row">
            {[true, false].map((yes) => (
              <button
                key={String(yes)}
                type="button"
                className="button secondary"
                disabled={busy || onAnswer === undefined}
                onClick={() => {
                  onAnswer?.(bet.id, yes);
                }}
              >
                {yes ? "Yes" : "No"}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="meta" role="status">
          {settle?.note ?? fallbackNote}
        </p>
      )}
      <HowGemmaDecided decisions={[{ decision: bet.decision }]} />
    </article>
  );
}

export function SettledLine({
  bet,
  animateStamp = false,
  busy = false,
  appealing = false,
  onAppeal,
}: {
  bet: Bet & { result: { verdict: string; points: number; evidence: string }; receipt: Receipt };
  animateStamp?: boolean;
  busy?: boolean;
  /** This bet's appeal is being decided. */
  appealing?: boolean;
  /** Appeal the verdict with a new photo (REQ-023); given only where the `appeals` flag is on. */
  onAppeal?: (betId: number, file: File) => void;
}) {
  return (
    <li className="settled-line">
      <ChoreTile title={bet.title} choreType={bet.chore_type} />
      <div className="line-main">
        <span className="line-title">
          {bet.title} · {betKindLabel(bet)}
        </span>
        <span className="meta">
          {formatOdds(bet.band_name, bet.odds)} · {bet.receipt.verdict_title}
        </span>
        <OddsWho source={bet.odds_source} gemma={bet.gemma} rule={bet.rule} />
      </div>
      <span className={`line-points ${bet.result.points < 0 ? "minus" : "plus"}`}>
        {formatPoints(bet.result.points)}
      </span>
      <details className="receipt-details">
        <summary>{bet.receipt.outcome === "paid_out" ? "Receipt" : "Result"}</summary>
        <ReceiptCard receipt={bet.receipt} animateStamp={animateStamp} />
        {onAppeal === undefined ? null : (
          <AppealAction receipt={bet.receipt} busy={busy} working={appealing} onAppeal={onAppeal} />
        )}
      </details>
    </li>
  );
}
