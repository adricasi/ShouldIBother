import { oddsOfBand } from "../../domain/bands.js";
import { CHORES, type ChoreType } from "../../domain/chores.js";
import { bandTable, plantsRuleQuote } from "../../domain/rules/index.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import type { LedgerDeps } from "./deps.js";
import type { CardRow, QuoteRow } from "./rows.js";
import { cardView, type CardView } from "./views.js";

/** How far ahead the forecast is read; the longest window is "now to next day 12:00". */
const FORECAST_HOURS = 48;
const MAX_TODAY_CARDS = 20;

export function latestQuote(deps: LedgerDeps, cardId: number): QuoteRow | undefined {
  return deps.db
    .prepare<[number], QuoteRow>("SELECT * FROM quotes WHERE card_id = ? ORDER BY id DESC LIMIT 1")
    .get(cardId);
}

/**
 * A quick chip creates its card without the listener (AC-002.5) and quotes the rule band at once
 * (AC-004.1, AC-013.1). The card and its quote are written together.
 */
export async function createQuickCard(deps: LedgerDeps, choreType: ChoreType): Promise<CardView> {
  const now = deps.now();
  const chore = CHORES[choreType];
  const settleAt = chore.ruleSettleAt(now);

  let forecast;
  try {
    forecast = await deps.weather.getForecast({ fromMs: now, hours: FORECAST_HOURS });
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      throw new HttpError(503, "No forecast available", "The weather could not be fetched.");
    }
    throw error;
  }
  const rule = plantsRuleQuote(forecast.hours, now, settleAt, deps.rules);
  if (rule === null) {
    throw new HttpError(503, "No forecast available", "The forecast does not cover this chore.");
  }
  const table = bandTable(deps.rules);

  const insert = deps.db.transaction((): { card: CardRow; quote: QuoteRow } => {
    const cardId = Number(
      deps.db
        .prepare(
          "INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES (?, ?, 'weather', ?)",
        )
        .run(chore.title, choreType, now).lastInsertRowid,
    );
    const quoteId = Number(
      deps.db
        .prepare(
          `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
           VALUES (?, 'rule', ?, ?, 0, ?, ?, ?)`,
        )
        .run(cardId, rule.band, oddsOfBand(table, rule.band), rule.reason, settleAt, now)
        .lastInsertRowid,
    );
    return {
      card: deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId)!,
      quote: deps.db.prepare<[number], QuoteRow>("SELECT * FROM quotes WHERE id = ?").get(quoteId)!,
    };
  });
  const { card, quote } = insert();
  return cardView(card, quote, table);
}

export function getCardView(deps: LedgerDeps, cardId: number): CardView {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  const quote = card === undefined ? undefined : latestQuote(deps, cardId);
  if (card === undefined || quote === undefined) {
    throw new HttpError(404, "Card not found");
  }
  return cardView(card, quote, bandTable(deps.rules));
}

/** Weather cards with no bet yet and a settle time still ahead, newest first. */
export function listOpenCards(deps: LedgerDeps): CardView[] {
  const cards = deps.db
    .prepare<[number], CardRow>(
      `SELECT c.* FROM cards c
       WHERE c.kind = 'weather'
         AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.card_id = c.id AND b.status != 'undone')
       ORDER BY c.id DESC LIMIT ?`,
    )
    .all(MAX_TODAY_CARDS);
  const table = bandTable(deps.rules);
  const now = deps.now();
  const views: CardView[] = [];
  for (const card of cards) {
    const quote = latestQuote(deps, card.id);
    if (quote !== undefined && quote.settle_at > now) {
      views.push(cardView(card, quote, table));
    }
  }
  return views;
}
