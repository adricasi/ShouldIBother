import type { Bet, Card, Settled, Today } from "./api.js";
import { formatLongDate, formatOdds, formatPoints, formatSettleTime } from "./format.js";
import { Nav } from "./Nav.js";

export interface QuickChip {
  readonly choreType: string;
  readonly label: string;
}

/** The chips of this build; the listener and more chores arrive with T-005 and T-006. */
export const QUICK_CHIPS: readonly QuickChip[] = [{ choreType: "plants", label: "Water plants" }];

export interface Notice {
  readonly kind: "error" | "info";
  readonly text: string;
}

export interface TodayScreenProps {
  readonly today: Today | undefined;
  readonly busy: boolean;
  readonly notice: Notice | undefined;
  /** Settle results of this session, by bet id; shown where the bet was. */
  readonly results: Readonly<Record<number, Settled>>;
  readonly onQuickCard: (choreType: string) => void;
  readonly onBet: (cardId: number) => void;
  readonly onSettle: (betId: number, answerId: string) => void;
}

const VERDICT_TITLES: Readonly<Record<string, string>> = {
  win: "You win",
  small_loss: "Small loss",
  normal_loss: "Loss",
  harmful_loss: "Harmful loss",
};

function OddsTile({ odds, bandName }: { odds: number; bandName: string }) {
  return (
    <div className="odds-tile">
      <span className="odds-figure">{odds}%</span>
      <span className="odds-band">{bandName}</span>
    </div>
  );
}

function CardSlip({
  card,
  busy,
  onBet,
}: {
  card: Card;
  busy: boolean;
  onBet: (id: number) => void;
}) {
  const { quote } = card;
  return (
    <article
      className="slip"
      aria-label={`${card.title}, ${quote.band_name}, ${quote.odds} percent`}
    >
      <p className="eyebrow">Lazy Bookie · Bet slip</p>
      <div className="slip-head">
        <h3>{card.title}</h3>
        <OddsTile odds={quote.odds} bandName={quote.band_name} />
      </div>
      <p className="label-tag">{quote.label}</p>
      <p>{quote.reason}</p>
      <p className="meta">Settles {formatSettleTime(quote.settle_at)}</p>
      <p className="payouts">
        <span className="win">Win {formatPoints(quote.payouts.win_with_tap)}</span>
        <span>
          If wrong {formatPoints(quote.payouts.small_loss)} to{" "}
          {formatPoints(quote.payouts.harmful_loss)}
        </span>
      </p>
      <button
        type="button"
        className="button primary"
        disabled={busy}
        onClick={() => {
          onBet(card.id);
        }}
      >
        Bet: do nothing
      </button>
    </article>
  );
}

function WaitingLine({ bet }: { bet: Bet }) {
  return (
    <li>
      <span>{bet.title}</span>
      <span className="meta">
        {formatOdds(bet.band_name, bet.odds)} · settles {formatSettleTime(bet.settle_at)}
      </span>
    </li>
  );
}

function ResultSlip({ result }: { result: Settled }) {
  return (
    <div className="result" role="status">
      <p className="eyebrow">Gemma&apos;s read</p>
      <p className="result-title">
        {VERDICT_TITLES[result.verdict] ?? result.verdict} · {formatPoints(result.points)}
      </p>
      <p>{result.reason}</p>
      {result.multiplier < 1 ? (
        <p className="meta">
          One tap pays half of a win. Total {formatPoints(result.total_points)}.
        </p>
      ) : null}
    </div>
  );
}

function DueSlip({
  bet,
  busy,
  onSettle,
}: {
  bet: Bet;
  busy: boolean;
  onSettle: (betId: number, answerId: string) => void;
}) {
  return (
    <article className="slip due" aria-label={`${bet.title}, ready to settle`}>
      <p className="eyebrow">Settle now · bet at {formatOdds(bet.band_name, bet.odds)}</p>
      <h3>{bet.title}</h3>
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
    </article>
  );
}

export function TodayScreen(props: TodayScreenProps) {
  const { today, busy, notice, results } = props;
  const settledResults = Object.values(results);
  return (
    <>
      <main className="screen">
        <header className="header">
          <div>
            <p className="eyebrow">{today === undefined ? "Today" : formatLongDate(today.now)}</p>
            <h1>The Lazy Bookie</h1>
          </div>
          {today === undefined ? null : (
            <p className="points" aria-label={`${today.points.total} points`}>
              {formatPoints(today.points.total)} pts
            </p>
          )}
        </header>

        {notice === undefined ? null : (
          <p
            className={`notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}

        <section aria-labelledby="chips-title">
          <h2 id="chips-title" className="section-title">
            What is on your list?
          </h2>
          <div className="chips">
            {QUICK_CHIPS.map((chip) => (
              <button
                key={chip.choreType}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => {
                  props.onQuickCard(chip.choreType);
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </section>

        {today === undefined ? (
          <p className="meta">Loading…</p>
        ) : (
          <>
            <section aria-labelledby="slips-title">
              <h2 id="slips-title" className="section-title">
                Today&apos;s slips
              </h2>
              {today.cards.length === 0 ? (
                <p className="empty">No chores yet. Tap a chip to get odds.</p>
              ) : (
                today.cards.map((card) => (
                  <CardSlip key={card.id} card={card} busy={busy} onBet={props.onBet} />
                ))
              )}
            </section>

            <section aria-labelledby="waiting-title">
              <h2 id="waiting-title" className="section-title">
                Waiting
              </h2>
              {today.open_bets.length === 0 ? (
                <p className="empty">Open bets wait here until they settle.</p>
              ) : (
                <ul className="waiting">
                  {today.open_bets.map((bet) => (
                    <WaitingLine key={bet.id} bet={bet} />
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="due-title">
              <h2 id="due-title" className="section-title">
                Settle now
              </h2>
              {today.due_bets.length === 0 && settledResults.length === 0 ? (
                <p className="empty">Bets ready to settle appear here.</p>
              ) : null}
              {today.due_bets.map((bet) => (
                <DueSlip key={bet.id} bet={bet} busy={busy} onSettle={props.onSettle} />
              ))}
              {settledResults.map((result) => (
                <ResultSlip key={result.bet_id} result={result} />
              ))}
            </section>
          </>
        )}
      </main>
      <Nav flags={today?.flags ?? {}} />
    </>
  );
}
