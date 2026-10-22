import type { Slips } from "./api.js";
import { DueSlip, SettledLine, WaitingLine } from "./BetParts.js";
import { Nav } from "./Nav.js";
import type { Notice } from "./notice.js";
import { isStampAnimated } from "./stamp.js";

export interface SlipsScreenProps {
  readonly slips: Slips | undefined;
  readonly flags: Readonly<Record<string, boolean>>;
  /** The server's clock estimated now, so countdowns tick without requests. */
  readonly nowMs: number;
  readonly busy: boolean;
  readonly notice: Notice | undefined;
  readonly onSettle: (betId: number, answerId: string) => void;
  readonly onSettlePhoto?: (betId: number, file: File) => void;
  readonly onSettleAnswer?: (betId: number, yes: boolean) => void;
  readonly onUndo: (betId: number) => void;
}

/** Empty states say what will appear in the group (AC-007.3). */
export const SLIPS_EMPTY_TEXT = {
  settleNow: "Bets whose settle time has come appear here, ready to settle with one tap.",
  waiting: "Bets you place wait here with a countdown to their settle time.",
  settled: "Settled bets appear here with Gemma's verdict and your points.",
} as const;

/** The Slips screen: Settle now, Waiting (time left) and Settled (result and points), REQ-007. */
export function SlipsScreen(props: SlipsScreenProps) {
  const { slips, nowMs, busy, notice } = props;
  return (
    <>
      <main className="screen">
        <header className="header">
          <div>
            <p className="eyebrow">Your bets</p>
            <h1 tabIndex={-1}>Slips</h1>
          </div>
        </header>

        {notice === undefined ? null : (
          <p
            className={`notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}

        {slips === undefined ? (
          <p className="meta">Loading…</p>
        ) : (
          <>
            <section aria-labelledby="settle-now-title">
              <h2 id="settle-now-title" className="section-title">
                Settle now
              </h2>
              {slips.settle_now.length === 0 ? (
                <p className="empty">{SLIPS_EMPTY_TEXT.settleNow}</p>
              ) : (
                slips.settle_now.map((bet) => (
                  <DueSlip
                    key={bet.id}
                    bet={bet}
                    busy={busy}
                    onSettle={props.onSettle}
                    {...(props.onSettlePhoto === undefined ? {} : { onPhoto: props.onSettlePhoto })}
                    {...(props.onSettleAnswer === undefined
                      ? {}
                      : { onAnswer: props.onSettleAnswer })}
                  />
                ))
              )}
            </section>

            <section aria-labelledby="waiting-title">
              <h2 id="waiting-title" className="section-title">
                Waiting
              </h2>
              {slips.waiting.length === 0 ? (
                <p className="empty">{SLIPS_EMPTY_TEXT.waiting}</p>
              ) : (
                <ul className="waiting">
                  {slips.waiting.map((bet) => (
                    <WaitingLine
                      key={bet.id}
                      bet={bet}
                      nowMs={nowMs}
                      busy={busy}
                      onUndo={props.onUndo}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="settled-title">
              <h2 id="settled-title" className="section-title">
                Settled
              </h2>
              {slips.settled.length === 0 ? (
                <p className="empty">{SLIPS_EMPTY_TEXT.settled}</p>
              ) : (
                <ul className="waiting">
                  {slips.settled.map((bet) => (
                    <SettledLine
                      key={bet.id}
                      bet={bet}
                      animateStamp={isStampAnimated(props.flags)}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
      <Nav flags={props.flags} current="slips" />
    </>
  );
}
