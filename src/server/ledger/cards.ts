import { oddsOfBand, type Band } from "../../domain/bands.js";
import { CHORES, type ChoreType } from "../../domain/chores.js";
import { bandTable } from "../../domain/rules/index.js";
import { madridWallTime } from "../../domain/time.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { ruleQuoteFor } from "./chore-rules.js";
import type { LedgerDeps } from "./deps.js";
import { launchBookmaker } from "./gemma-cards.js";
import { latestQuote } from "./quotes.js";
import type { CardRow, QuoteRow } from "./rows.js";
import { cardView, type CardView } from "./views.js";

/** How far ahead the forecast is read; the longest window is "now to next day 12:00". */
export const FORECAST_HOURS = 48;
const MAX_TODAY_CARDS = 20;

/** A card to create: a weather chore the app can quote, or one that gets no odds. */
export type PlannedCard =
  | { readonly kind: "weather"; readonly choreType: ChoreType; readonly label: string }
  | {
      readonly kind: "not_weather" | "coming_later";
      /** The listener's chore type, kept as written. */
      readonly choreType: string;
      readonly label: string;
    };

/**
 * Creates the cards of one capture in a single transaction. Each weather card gets the rule quote
 * at once (AC-004.1, AC-013.1) and a background bookmaker job; the other cards have no odds and
 * no bet action (AC-002.2, AC-002.3). All or nothing: if the forecast is missing, no card exists.
 */
export async function createCards(
  deps: LedgerDeps,
  planned: readonly PlannedCard[],
): Promise<CardView[]> {
  const now = deps.now();
  const table = bandTable(deps.rules);
  let hours: Awaited<ReturnType<LedgerDeps["weather"]["getForecast"]>>["hours"] = [];
  if (planned.some((card) => card.kind === "weather")) {
    try {
      hours = (await deps.weather.getForecast({ fromMs: now, hours: FORECAST_HOURS })).hours;
    } catch (error) {
      if (error instanceof WeatherUnavailableError) {
        throw new HttpError(503, "No forecast available", "The weather could not be fetched.");
      }
      throw error;
    }
  }

  const rules = new Map<number, { band: Band; reason: string; settleAt: number }>();
  planned.forEach((card, index) => {
    if (card.kind !== "weather") {
      return;
    }
    const settleAt = CHORES[card.choreType].ruleSettleAt(now);
    const rule = ruleQuoteFor(card.choreType, hours, now, settleAt, deps.rules);
    if (rule === null) {
      throw new HttpError(503, "No forecast available", "The forecast does not cover this chore.");
    }
    rules.set(index, { band: rule.band, reason: rule.reason, settleAt });
  });

  const insert = deps.db.transaction((): { card: CardRow; quote: QuoteRow | undefined }[] =>
    planned.map((card, index) => {
      const rule = rules.get(index);
      const cardId = Number(
        deps.db
          .prepare(
            `INSERT INTO cards (input_text, chore_type, kind, created_at, gemma_state)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            card.label,
            card.choreType,
            card.kind,
            now,
            card.kind === "weather" ? "thinking" : null,
          ).lastInsertRowid,
      );
      let quoteId: number | undefined;
      if (rule !== undefined) {
        quoteId = Number(
          deps.db
            .prepare(
              `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
               VALUES (?, 'rule', ?, ?, 0, ?, ?, ?)`,
            )
            .run(cardId, rule.band, oddsOfBand(table, rule.band), rule.reason, rule.settleAt, now)
            .lastInsertRowid,
        );
      }
      return {
        card: deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId)!,
        quote:
          quoteId === undefined
            ? undefined
            : deps.db.prepare<[number], QuoteRow>("SELECT * FROM quotes WHERE id = ?").get(quoteId),
      };
    }),
  );
  const created = insert();
  for (const { card } of created) {
    if (card.kind === "weather") {
      launchBookmaker(deps, card.id);
    }
  }
  return created.map(({ card, quote }) => cardView(card, quote, table));
}

/** A quick chip creates its card without the listener (AC-002.5). */
export function createQuickCard(deps: LedgerDeps, choreType: ChoreType): Promise<CardView> {
  return createCards(deps, [{ kind: "weather", choreType, label: CHORES[choreType].title }]).then(
    ([card]) => card!,
  );
}

export function getCardView(deps: LedgerDeps, cardId: number): CardView {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  const quote = latestQuote(deps, cardId);
  if (quote === undefined && card.kind === "weather") {
    throw new HttpError(404, "Card not found");
  }
  return cardView(card, quote, bandTable(deps.rules));
}

/**
 * Weather cards with no bet yet and a settle time still ahead, and today's cards that have no
 * odds (so "Not a weather chore" and "Coming later" are seen), newest first.
 */
export function listOpenCards(deps: LedgerDeps): CardView[] {
  const cards = deps.db
    .prepare<[number], CardRow>(
      `SELECT c.* FROM cards c
       WHERE c.kind IN ('weather', 'not_weather', 'coming_later')
         AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.card_id = c.id AND b.status != 'undone')
       ORDER BY c.id DESC LIMIT ?`,
    )
    .all(MAX_TODAY_CARDS * 2);
  const table = bandTable(deps.rules);
  const now = deps.now();
  const startOfDay = madridWallTime(now, 0, 0);
  const views: CardView[] = [];
  for (const card of cards) {
    if (card.kind === "weather") {
      const quote = latestQuote(deps, card.id);
      if (quote !== undefined && quote.settle_at > now) {
        views.push(cardView(card, quote, table));
      }
    } else if (card.created_at >= startOfDay) {
      views.push(cardView(card, undefined, table));
    }
    if (views.length >= MAX_TODAY_CARDS) {
      break;
    }
  }
  return views;
}
