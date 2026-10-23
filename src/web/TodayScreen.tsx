import type { ReactNode } from "react";

import { PLANNER_CHIP, type Card, type Receipt, type Today } from "./api.js";
import { DueSlip, WaitingLine, type SettleActions } from "./BetParts.js";
import { ReceiptCard, WeekStrip } from "./SettleParts.js";
import { PhotoBlock, type PhotoActions } from "./PhotoParts.js";
import { PlanDays, PlannerSlip, type PlannerActions } from "./PlannerParts.js";
import { formatOdds, formatPoints, formatSettleTime } from "./format.js";
import { Nav } from "./Nav.js";
import type { Notice } from "./notice.js";
import { isStampAnimated } from "./stamp.js";
import { CaptureBar, QuickChips, TodayHeader, type ChipSpec } from "./TodayParts.js";
import { WeatherBoard } from "./WeatherBoard.js";
import { ChoreTile } from "./ui/ChoreTile.js";
import { Icon } from "./ui/Icon.js";
import { NoticeBanner } from "./ui/NoticeBanner.js";
import { PrivacyProvider } from "./ui/PrivacyNote.js";
import { EmptyState, ErrorState, LoadingState } from "./ui/States.js";

export type QuickChip = ChipSpec;

/** The chips for the Must chores; the typed sentence (the listener) covers everything else. */
export const QUICK_CHIPS: readonly QuickChip[] = [
  { choreType: "plants", label: "Water plants" },
  { choreType: "laundry_line", label: "Line-dry today" },
];

/** The chip for "Skip the heater" (REQ-016, AC-016.3); shown only while the `heater` flag is on. */
export const HEATER_CHIP: QuickChip = { choreType: "heater", label: "Skip the heater" };

export interface TodayScreenProps {
  readonly today: Today | undefined;
  /** A card above the chips: the household question while onboarding is pending (REQ-024). */
  readonly prompt?: ReactNode;
  readonly busy: boolean;
  readonly notice: Notice | undefined;
  /** Receipts of the bets settled in this session, by bet id; shown where the bet was. */
  readonly results: Readonly<Record<number, Receipt>>;
  readonly onQuickCard: (choreType: string) => void;
  /** Typed capture; true when the cards were made, so the box can be cleared (AC-002.4). */
  readonly onCapture: (text: string) => Promise<boolean>;
  readonly onRetry: (cardId: number) => void;
  readonly onAnswer: (cardId: number, yes: boolean) => void;
  /** The server's clock estimated now, for the Undo countdown. */
  readonly nowMs: number;
  readonly onBet: (cardId: number, quoteId: number) => void;
  readonly onDoIt: (cardId: number, quoteId: number) => void;
  readonly onUndo: (betId: number) => void;
  readonly onSettle: (betId: number, answerId: string) => void;
  /** Settle with an after photo, paid in full (AC-008.2). */
  readonly onSettlePhoto?: (betId: number, file: File) => void;
  /** Answer the judge's yes/no question (AC-008.5). */
  readonly onSettleAnswer?: (betId: number, yes: boolean) => void;
  /** Add or replace a card's before photo (REQ-005); absent in screens that cannot upload. */
  readonly onPhoto?: (cardId: number, file: File) => void;
  /** Delete a photo and what was derived from it (AC-015.2). */
  readonly onDeletePhoto?: (photoId: string) => void;
  /** The rank for the points total (flag `ranks`), shown in the points chip. */
  readonly rankName?: string;
  /**
   * The voice capture button, rendered inside the capture bar (flag `voice`, only while the
   * microphone is available, AC-027.3). Absent: no mic is shown.
   */
  readonly voiceControl?: ReactNode;
  /** The raised centre button of the tab bar (the voice mic); absent: four plain tabs. */
  readonly voiceFab?: ReactNode;
  /** Reload Today after a failed first load (the error state's Try again). */
  readonly onReload?: () => void;
  /** Laundry planner (flag `laundryPlanner`): "Need anything washed before <day>?" (AC-021.2). */
  readonly onPlanNeed?: (cardId: number, needed: boolean) => void;
  /** Laundry planner: follow Wash today (AC-021.3). */
  readonly onPlanFollow?: (cardId: number) => void;
}

function OddsTile({ odds, bandName }: { odds: number; bandName: string }) {
  return (
    // Plain words next to every percentage (AC-003.5): "Likely · 70%".
    <div className="odds-tile" role="img" aria-label={formatOdds(bandName, odds)}>
      <span className="odds-figure">{odds}%</span>
      <span className="odds-band">{bandName}</span>
    </div>
  );
}

/** What Gemma is doing about a card: thinking, a question to answer, or offline with Retry. */
function GemmaBlock({
  card,
  busy,
  onRetry,
  onAnswer,
}: {
  card: Card;
  busy: boolean;
  onRetry: (cardId: number) => void;
  onAnswer: (cardId: number, yes: boolean) => void;
}) {
  const gemma = card.gemma;
  if (gemma === null) {
    return null;
  }
  if (gemma.state === "question" && gemma.question !== null) {
    // AC-003.3: the question inside the card, as two tap answers.
    return (
      <div className="gemma-question">
        <p className="question">{gemma.question}</p>
        <div className="answers">
          {[true, false].map((yes) => (
            <button
              key={String(yes)}
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                onAnswer(card.id, yes);
              }}
            >
              {yes ? "Yes" : "No"}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (gemma.state === "offline") {
    // AC-013.3: rule odds stay, betting is still allowed, Retry asks Gemma again.
    return (
      <div className="gemma-offline">
        {gemma.note === null ? null : <p className="meta">{gemma.note}</p>}
        {gemma.can_retry ? (
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => {
              onRetry(card.id);
            }}
          >
            Retry Gemma
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

function CardSlip({
  card,
  busy,
  onBet,
  onDoIt,
  onRetry,
  onAnswer,
  photoActions,
  plannerActions,
}: {
  card: Card;
  busy: boolean;
  onBet: (cardId: number, quoteId: number) => void;
  onDoIt: (cardId: number, quoteId: number) => void;
  onRetry: (cardId: number) => void;
  onAnswer: (cardId: number, yes: boolean) => void;
  photoActions: PhotoActions | undefined;
  plannerActions: PlannerActions | undefined;
}) {
  const { quote } = card;
  const plan = card.laundry_plan ?? null;
  if (card.kind === "alert") {
    // AC-012.1: a "Do it now" alert has a reason and no bet action.
    return (
      <article className="slip alert" aria-label={`${card.title}, do it now`}>
        <p className="eyebrow">
          <Icon name="alert" /> Lazy Bookie · Safety
        </p>
        <h3>Do it now: {card.title}</h3>
        <p role="alert">{card.alert_reason}</p>
        <p className="meta">The weather is too risky to bet on this one.</p>
      </article>
    );
  }
  if (plan !== null && quote === null) {
    // Laundry planner advice (AC-021.1 to AC-021.3): Wash today, No good day, or a question.
    return (
      <PlannerSlip
        card={card}
        plan={plan}
        busy={busy}
        actions={plannerActions}
        onRetry={onRetry}
        onAnswer={onAnswer}
      />
    );
  }
  if (quote === null) {
    // AC-014.4, AC-016.4, AC-016.5: no odds, and no bet action, with the reason in words.
    return (
      <article className="slip no-bet" aria-label={`${card.title}, no odds`}>
        <div className="slip-head">
          <ChoreTile title={card.title} choreType={card.chore_type} />
          <div className="line-main">
            <h3>{card.title}</h3>
            <p>{card.notice}</p>
          </div>
          <span className="pill muted">No bet</span>
        </div>
      </article>
    );
  }
  return (
    <article
      className="slip ticket"
      aria-label={`${card.title}, ${formatOdds(quote.band_name, quote.odds)}`}
    >
      <div className="slip-top">
        <p className="eyebrow">Lazy Bookie · Bet slip</p>
        <p className="eyebrow">Nº {String(card.id).padStart(4, "0")}</p>
      </div>
      <hr className="rule" />
      <div className="slip-head">
        <ChoreTile title={card.title} choreType={card.chore_type} />
        <div className="line-main">
          <h3>{card.title}</h3>
          <p className="meta settles">
            <Icon name="clock" /> Settles {formatSettleTime(quote.settle_at)}
          </p>
        </div>
        <OddsTile odds={quote.odds} bandName={quote.band_name} />
      </div>
      <p className="label-tag">{quote.label}</p>
      <p>{quote.reason}</p>
      {plan === null ? null : <PlanDays plan={plan} />}
      <GemmaBlock card={card} busy={busy} onRetry={onRetry} onAnswer={onAnswer} />
      {plan === null ? <PhotoBlock card={card} busy={busy} actions={photoActions} /> : null}
      <hr className="rule notched" />
      <p className="payouts">
        <span className="win">Win {formatPoints(quote.payouts.win_with_tap)}</span>
        <span className="wrong">
          If wrong {formatPoints(quote.payouts.small_loss)} to{" "}
          {formatPoints(quote.payouts.harmful_loss)}
        </span>
      </p>
      <div className="button-row">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => {
            onBet(card.id, quote.id);
          }}
        >
          Bet: do nothing
        </button>
        {plan === null ? (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              onDoIt(card.id, quote.id);
            }}
          >
            I&apos;ll do it
          </button>
        ) : null}
      </div>
      {plan === null ? (
        <p className="meta">
          I&apos;ll do it scores {formatPoints(quote.payouts.do_it_if_not_needed)} if the weather
          would not have helped, {formatPoints(quote.payouts.do_it_if_needed)} if it would have.
        </p>
      ) : (
        <p className="meta">
          Skip today wins if the load dries outside on {plan.best_day?.weekday ?? "that day"}.
        </p>
      )}
    </article>
  );
}

export function TodayScreen(props: TodayScreenProps) {
  const { today, busy, notice, results } = props;
  const photoActions: PhotoActions | undefined =
    props.onPhoto === undefined || props.onDeletePhoto === undefined
      ? undefined
      : { onPhoto: props.onPhoto, onDeletePhoto: props.onDeletePhoto };
  const plannerActions: PlannerActions | undefined =
    props.onPlanNeed === undefined || props.onPlanFollow === undefined
      ? undefined
      : { onNeed: props.onPlanNeed, onFollow: props.onPlanFollow };
  const settledResults = Object.values(results);
  const chips: QuickChip[] = [
    ...QUICK_CHIPS,
    ...(today?.flags["heater"] === true ? [HEATER_CHIP] : []),
    ...(today?.flags["laundryPlanner"] === true
      ? [{ choreType: PLANNER_CHIP, label: "Plan the wash" }]
      : []),
  ];
  const settleActions: SettleActions = {
    onSettle: props.onSettle,
    ...(props.onSettlePhoto === undefined ? {} : { onPhoto: props.onSettlePhoto }),
    ...(props.onSettleAnswer === undefined ? {} : { onAnswer: props.onSettleAnswer }),
  };
  return (
    <PrivacyProvider voice={today?.flags["voice"] === true}>
      <main className="screen">
        <TodayHeader today={today} rankName={props.rankName} />

        {today === undefined ? null : (
          <WeekStrip totals={today.week.totals} from={today.week.from} to={today.week.to} />
        )}

        {today?.flags["splitFlap"] === true ? (
          <WeatherBoard
            board={today.weather_board ?? null}
            now={today.now}
            forecast={today.forecast}
          />
        ) : today?.forecast == null ? null : (
          <p className={`meta forecast-age${today.forecast.stale ? " stale" : ""}`}>
            {today.forecast.age_label}
            {today.forecast.stale ? ". Open-Meteo could not be reached for a newer one." : ""}
          </p>
        )}

        {today === undefined && notice?.kind === "error" ? (
          <ErrorState title="Can't reach the Lazy Bookie" busy={busy} onRetry={props.onReload}>
            {notice.text} Your bets are safe; this screen tries again every 30 seconds.
          </ErrorState>
        ) : (
          <NoticeBanner notice={notice} />
        )}

        {props.prompt}

        <section aria-labelledby="chips-title" className="capture">
          <h2 id="chips-title" className="sr-only">
            What is on your list?
          </h2>
          <CaptureBar busy={busy} onCapture={props.onCapture} micSlot={props.voiceControl} />
          <QuickChips chips={chips} busy={busy} onPick={props.onQuickCard} />
        </section>

        {today === undefined ? (
          notice?.kind === "error" ? null : (
            <LoadingState what="today's slips" />
          )
        ) : (
          <>
            <section aria-labelledby="slips-title">
              <h2 id="slips-title" className="section-title">
                Today&apos;s slips
              </h2>
              {today.cards.length === 0 ? (
                <EmptyState icon="sun">No chores yet. Tap a chip to get odds.</EmptyState>
              ) : (
                today.cards.map((card) => (
                  <CardSlip
                    key={card.id}
                    card={card}
                    busy={busy}
                    onBet={props.onBet}
                    onDoIt={props.onDoIt}
                    onRetry={props.onRetry}
                    onAnswer={props.onAnswer}
                    photoActions={photoActions}
                    plannerActions={plannerActions}
                  />
                ))
              )}
            </section>

            <section aria-labelledby="waiting-title">
              <h2 id="waiting-title" className="section-title">
                Waiting
              </h2>
              {today.open_bets.length === 0 ? (
                <EmptyState icon="clock">Open bets wait here until they settle.</EmptyState>
              ) : (
                <ul className="waiting">
                  {today.open_bets.map((bet) => (
                    <WaitingLine
                      key={bet.id}
                      bet={bet}
                      nowMs={props.nowMs}
                      busy={busy}
                      onUndo={props.onUndo}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="due-title">
              <h2 id="due-title" className="section-title">
                Settle now
              </h2>
              {today.due_bets.length === 0 && settledResults.length === 0 ? (
                <EmptyState icon="ticket">Bets ready to settle appear here.</EmptyState>
              ) : null}
              {today.due_bets.map((bet) => (
                <DueSlip key={bet.id} bet={bet} busy={busy} {...settleActions} />
              ))}
              {settledResults.map((receipt) => (
                <ReceiptCard
                  key={receipt.bet_id}
                  receipt={receipt}
                  animateStamp={isStampAnimated(today.flags)}
                />
              ))}
            </section>
          </>
        )}
        {today === undefined ? null : <p className="meta attribution">{today.attribution}</p>}
      </main>
      <Nav flags={today?.flags ?? {}} fab={props.voiceFab} />
    </PrivacyProvider>
  );
}
