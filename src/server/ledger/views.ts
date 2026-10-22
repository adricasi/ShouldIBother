import { nameOfBand, type BandTable } from "../../domain/bands.js";
import { CHORES, NOTICES, isChoreType } from "../../domain/chores.js";
import { canUndo } from "../../domain/bet-state.js";
import { DO_IT_POINTS, LOSS_POINTS, winPoints } from "../../domain/points.js";

import type { BetRow, CardRow, QuoteRow } from "./rows.js";

/** What the person can win or lose at these odds, computed by code (AC-003.2). */
export interface Payouts {
  readonly win_with_photo: number;
  readonly win_with_tap: number;
  readonly small_loss: number;
  readonly normal_loss: number;
  readonly harmful_loss: number;
  /** "I'll do it" scores +5 when the weather would not have helped, -10 when it would (AC-009.3). */
  readonly do_it_if_not_needed: number;
  readonly do_it_if_needed: number;
}

export function payoutsAt(odds: number): Payouts {
  return {
    win_with_photo: winPoints(odds, "photo"),
    win_with_tap: winPoints(odds, "tap"),
    small_loss: LOSS_POINTS.small_loss,
    normal_loss: LOSS_POINTS.normal_loss,
    harmful_loss: LOSS_POINTS.harmful_loss,
    do_it_if_not_needed: DO_IT_POINTS.weather_would_not,
    do_it_if_needed: DO_IT_POINTS.weather_would_have,
  };
}

/**
 * The label above the odds (AC-013.1). A rule quote is provisional while Gemma may still
 * answer; this build has no bookmaker job yet (T-006), so it stays provisional.
 */
export function quoteLabel(source: "rule" | "gemma", provisional: boolean): string {
  if (source === "gemma") {
    return "Gemma's odds";
  }
  return provisional ? "Gemma is thinking · rule odds" : "Rule odds";
}

export function quoteView(quote: QuoteRow, table: BandTable) {
  const provisional = quote.source === "rule";
  return {
    id: quote.id,
    source: quote.source,
    band: quote.band,
    band_name: nameOfBand(table, quote.band),
    odds: quote.odds,
    reason: quote.reason,
    settle_at: new Date(quote.settle_at).toISOString(),
    label: quoteLabel(quote.source, provisional),
    provisional,
    payouts: payoutsAt(quote.odds),
  };
}

export type QuoteView = ReturnType<typeof quoteView>;

/**
 * A bet as the client sees it. `undoable` is computed at read time from the clock (AC-006.4,
 * AC-006.5): the client never decides alone whether Undo is offered.
 */
export function betView(bet: BetRow, card: CardRow, table: BandTable, nowMs: number) {
  const chore = isChoreType(card.chore_type) ? CHORES[card.chore_type] : undefined;
  return {
    id: bet.id,
    card_id: bet.card_id,
    title: chore?.title ?? card.chore_type,
    kind: bet.kind,
    band: bet.band,
    band_name: nameOfBand(table, bet.band),
    odds: bet.odds,
    odds_source: bet.odds_source,
    reason: bet.reason,
    placed_at: new Date(bet.placed_at).toISOString(),
    undo_until: new Date(bet.undo_until).toISOString(),
    undoable: canUndo({ status: bet.status, undoUntil: bet.undo_until }, nowMs),
    settle_at: new Date(bet.settle_at).toISOString(),
    status: bet.status,
    payouts: payoutsAt(bet.odds),
    // A do-it decision has no question: the judge decides from the recorded weather (AC-008.9).
    tap_answers: bet.kind === "do_nothing" ? (chore?.tapAnswers ?? []) : [],
  };
}

export type BetView = ReturnType<typeof betView>;

export function cardView(card: CardRow, quote: QuoteRow | undefined, table: BandTable) {
  const chore = isChoreType(card.chore_type) ? CHORES[card.chore_type] : undefined;
  return {
    id: card.id,
    chore_type: card.chore_type,
    kind: card.kind,
    title: chore?.title ?? card.chore_type,
    created_at: new Date(card.created_at).toISOString(),
    /** Set on a "Do it now" alert: the reason, and the card has no odds and no bet action (AC-012.1). */
    alert_reason: card.alert_reason,
    /** Set on a card without odds that explains why (AC-014.4, AC-016.4, AC-016.5). */
    notice: card.kind === "coming_later" ? (card.notice ?? NOTICES.comingLater) : card.notice,
    /** Null on every card that cannot be bet on. */
    quote: quote === undefined ? null : quoteView(quote, table),
  };
}

export type CardView = ReturnType<typeof cardView>;
