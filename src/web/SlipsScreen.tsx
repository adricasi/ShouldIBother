import type { ReactNode } from "react";

import type { Slips } from "./api.js";
import { DueSlip, SettledLine, WaitingLine } from "./BetParts.js";
import { isMadridToday } from "./format.js";
import { GroupJump } from "./SlipsParts.js";
import { Nav } from "./Nav.js";
import type { Notice } from "./notice.js";
import { isStampAnimated } from "./stamp.js";
import { NoticeBanner } from "./ui/NoticeBanner.js";
import { PrivacyProvider } from "./ui/PrivacyNote.js";
import { EmptyState, ErrorState, LoadingState } from "./ui/States.js";

export interface SlipsScreenProps {
  readonly slips: Slips | undefined;
  readonly flags: Readonly<Record<string, boolean>>;
  /** The raised voice button of the tab bar (flag `voice`, mic available); absent: plain tabs. */
  readonly fab?: ReactNode;
  /** The server's clock estimated now, so countdowns tick without requests. */
  readonly nowMs: number;
  readonly busy: boolean;
  readonly notice: Notice | undefined;
  readonly onSettle: (betId: number, answerId: string) => void;
  readonly onSettlePhoto?: (betId: number, file: File) => void;
  readonly onSettleAnswer?: (betId: number, yes: boolean) => void;
  readonly onUndo: (betId: number) => void;
  /** Cash out a waiting bet at -10 points; given only where the `rescue` flag is on (REQ-022). */
  readonly onCashOut?: (betId: number) => void;
  /** Appeal a settled bet with a new photo; given only where the `appeals` flag is on (REQ-023). */
  readonly onAppeal?: (betId: number, file: File) => void;
  /** The bet whose appeal Gemma is deciding now, if any. */
  readonly appealingBetId?: number;

  /** Reload after a failed first load (the error state's Try again). */
  readonly onReload?: () => void;
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
    <PrivacyProvider voice={props.flags["voice"] === true}>
      <main className="screen">
        <header className="header">
          <div>
            <p className="eyebrow">
              {slips === undefined
                ? "Your bets"
                : `${slips.waiting.length + slips.settle_now.length} open · ${slips.settle_now.length} to settle`}
            </p>
            <h1 tabIndex={-1}>Slips</h1>
          </div>
        </header>

        {slips === undefined && notice?.kind === "error" ? (
          <ErrorState title="Can't load your slips" busy={busy} onRetry={props.onReload}>
            {notice.text} Your bets are safe; this screen tries again every 30 seconds.
          </ErrorState>
        ) : (
          <NoticeBanner notice={notice} />
        )}

        {slips === undefined ? (
          notice?.kind === "error" ? null : (
            <LoadingState what="your slips" />
          )
        ) : (
          <>
            <GroupJump
              groups={[
                { id: "settle-now-title", label: "Settle now", count: slips.settle_now.length },
                { id: "waiting-title", label: "Waiting", count: slips.waiting.length },
                { id: "settled-title", label: "Settled" },
              ]}
            />

            <section aria-labelledby="settle-now-title">
              <h2 id="settle-now-title" className="section-title" tabIndex={-1}>
                Settle now
              </h2>
              {slips.settle_now.length === 0 ? (
                <EmptyState icon="ticket">{SLIPS_EMPTY_TEXT.settleNow}</EmptyState>
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
              <h2 id="waiting-title" className="section-title" tabIndex={-1}>
                Waiting
              </h2>
              {slips.waiting.length === 0 ? (
                <EmptyState icon="clock">{SLIPS_EMPTY_TEXT.waiting}</EmptyState>
              ) : (
                <ul className="waiting">
                  {slips.waiting.map((bet) => (
                    <WaitingLine
                      key={bet.id}
                      bet={bet}
                      nowMs={nowMs}
                      busy={busy}
                      onUndo={props.onUndo}
                      {...(props.onCashOut === undefined ? {} : { onCashOut: props.onCashOut })}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="settled-title">
              <h2 id="settled-title" className="section-title" tabIndex={-1}>
                Settled
              </h2>
              {slips.settled.length === 0 ? (
                <EmptyState icon="trophy">{SLIPS_EMPTY_TEXT.settled}</EmptyState>
              ) : (
                <ul className="waiting settled-list">
                  {slips.settled.map((bet) => (
                    <SettledLine
                      key={bet.id}
                      bet={bet}
                      busy={busy}
                      appealing={props.appealingBetId === bet.id}
                      {...(props.onAppeal === undefined ? {} : { onAppeal: props.onAppeal })}
                      animateStamp={
                        isStampAnimated(props.flags) && isMadridToday(bet.receipt.settled_at, nowMs)
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
      <Nav flags={props.flags} current="slips" fab={props.fab} />
    </PrivacyProvider>
  );
}
