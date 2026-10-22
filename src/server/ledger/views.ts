import { nameOfBand, type BandTable } from "../../domain/bands.js";
import { CHORES, isChoreType } from "../../domain/chores.js";
import { winPoints, LOSS_POINTS } from "../../domain/points.js";

import type { BetRow, CardRow, QuoteRow } from "./rows.js";

/** What the person can win or lose at these odds, computed by code (AC-003.2). */
export interface Payouts {
  readonly win_with_photo: number;
  readonly win_with_tap: number;
  readonly small_loss: number;
  readonly normal_loss: number;
  readonly harmful_loss: number;
}

export function payoutsAt(odds: number): Payouts {
  return {
    win_with_photo: winPoints(odds, "photo"),
    win_with_tap: winPoints(odds, "tap"),
    small_loss: LOSS_POINTS.small_loss,
    normal_loss: LOSS_POINTS.normal_loss,
    harmful_loss: LOSS_POINTS.harmful_loss,
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

export function betView(bet: BetRow, card: CardRow, table: BandTable) {
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
    settle_at: new Date(bet.settle_at).toISOString(),
    status: bet.status,
    payouts: payoutsAt(bet.odds),
    tap_answers: chore?.tapAnswers ?? [],
  };
}

export type BetView = ReturnType<typeof betView>;

export function cardView(card: CardRow, quote: QuoteRow, table: BandTable) {
  const chore = isChoreType(card.chore_type) ? CHORES[card.chore_type] : undefined;
  return {
    id: card.id,
    chore_type: card.chore_type,
    kind: card.kind,
    title: chore?.title ?? card.chore_type,
    created_at: new Date(card.created_at).toISOString(),
    quote: quoteView(quote, table),
  };
}

export type CardView = ReturnType<typeof cardView>;
