import { oddsOfBand } from "../../domain/bands.js";
import { CHORES, NOTICES, offerNotice, type ChoreType } from "../../domain/chores.js";
import { bandTable, ruleQuote, safetyAlert } from "../../domain/rules/index.js";
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

/** Cards without odds (alerts, notices) leave Today after this long; they are not bets in waiting. */
const QUIET_CARD_TTL_MS = 12 * 60 * 60 * 1000;

function insertCard(
  deps: LedgerDeps,
  fields: {
    readonly choreType: ChoreType;
    readonly kind: CardRow["kind"];
    readonly alertReason?: string;
    readonly notice?: string;
  },
): CardRow {
  const now = deps.now();
  const id = Number(
    deps.db
      .prepare(
        `INSERT INTO cards (input_text, chore_type, kind, alert_reason, notice, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        CHORES[fields.choreType].title,
        fields.choreType,
        fields.kind,
        fields.alertReason ?? null,
        fields.notice ?? null,
        now,
      ).lastInsertRowid,
  );
  return deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(id)!;
}

/** A card with no odds and no bet action that says why (AC-014.4, AC-016.4, AC-016.5). */
function noOddsCard(deps: LedgerDeps, choreType: ChoreType, notice: string): CardView {
  const card = insertCard(deps, { choreType, kind: "coming_later", notice });
  return cardView(card, undefined, bandTable(deps.rules));
}

/** Chores that exist only behind a flag or a later task; until then they read "Coming later". */
function isOfferedYet(deps: LedgerDeps, choreType: ChoreType): boolean {
  switch (choreType) {
    case "plants":
    case "laundry_line":
      return true;
    case "ac":
    case "heater":
      return deps.flags.heater;
    case "laundry_tonight":
      // T-013 builds the sunset offer window and turns this on behind `laundryTonight`.
      return false;
  }
}

/** AC and heater are skipped only when the household baseline says they are used (AC-016.5). */
function isNotNeeded(deps: LedgerDeps, choreType: ChoreType): boolean {
  return (
    (choreType === "ac" && !deps.household.airConditioning) ||
    (choreType === "heater" && !deps.household.heaterThisSeason)
  );
}

/**
 * Creates the card of a chore, either as a bettable card with its rule quote, or as a card that
 * has no odds and says why. A quick chip uses this without the listener (AC-002.5); the listener
 * (T-006) calls it once per chore it finds. In order:
 *
 * 1. AC or heater the household does not use this season: "Not needed this season" (AC-016.5).
 * 2. A chore not offered yet: "Coming later".
 * 3. Line-dry outside 07:00 to 15:00: says when it can be offered (AC-016.4).
 * 4. No forecast younger than 24 h: "No forecast, can't set odds", no betting (AC-014.4).
 * 5. The fixed heat, frost or storm backstop: a "Do it now" alert with its reason, no odds, no bet
 *    action, whatever Gemma would say (AC-012.1).
 * 6. Otherwise the rule band is quoted at once (AC-004.1, AC-013.1): the card and quote are
 *    written together.
 */
export async function createChoreCard(deps: LedgerDeps, choreType: ChoreType): Promise<CardView> {
  const now = deps.now();
  const chore = CHORES[choreType];
  const table = bandTable(deps.rules);

  if (isNotNeeded(deps, choreType)) {
    return noOddsCard(deps, choreType, NOTICES.notNeeded);
  }
  if (!isOfferedYet(deps, choreType)) {
    return noOddsCard(deps, choreType, NOTICES.comingLater);
  }
  const offer = chore.offer?.(now);
  if (offer !== undefined && !offer.offered) {
    return noOddsCard(deps, choreType, offerNotice(choreType, now, offer.nextAtMs));
  }

  let forecast;
  try {
    forecast = await deps.weather.getForecast({ fromMs: now, hours: FORECAST_HOURS });
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      return noOddsCard(deps, choreType, NOTICES.noForecast);
    }
    throw error;
  }

  const window = chore.ruleWindow(now);
  const alert = safetyAlert(forecast.hours, window.fromMs, window.toMs, deps.rules);
  if (alert !== null) {
    const card = insertCard(deps, { choreType, kind: "alert", alertReason: alert.reason });
    return cardView(card, undefined, table);
  }
  const rule = ruleQuote(choreType, forecast.hours, window.fromMs, window.toMs, deps.rules);
  if (rule === null) {
    return noOddsCard(deps, choreType, NOTICES.noForecast);
  }

  const insert = deps.db.transaction((): { card: CardRow; quote: QuoteRow } => {
    const card = insertCard(deps, { choreType, kind: "weather" });
    const quoteId = Number(
      deps.db
        .prepare(
          `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
           VALUES (?, 'rule', ?, ?, 0, ?, ?, ?)`,
        )
        .run(card.id, rule.band, oddsOfBand(table, rule.band), rule.reason, window.toMs, now)
        .lastInsertRowid,
    );
    return {
      card,
      quote: deps.db.prepare<[number], QuoteRow>("SELECT * FROM quotes WHERE id = ?").get(quoteId)!,
    };
  });
  const { card, quote } = insert();
  return cardView(card, quote, table);
}

/** A quick chip's card (AC-002.5). */
export const createQuickCard = createChoreCard;

export function getCardView(deps: LedgerDeps, cardId: number): CardView {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  const quote = latestQuote(deps, cardId);
  if (card.kind === "weather" && quote === undefined) {
    throw new HttpError(404, "Card not found");
  }
  return cardView(card, quote, bandTable(deps.rules));
}

/**
 * Cards on Today, newest first: weather cards with no bet yet and a settle time still ahead, and
 * the cards without odds (alerts, notices) for the next hours.
 */
export function listOpenCards(deps: LedgerDeps): CardView[] {
  const cards = deps.db
    .prepare<[number], CardRow>(
      `SELECT c.* FROM cards c
       WHERE NOT EXISTS (SELECT 1 FROM bets b WHERE b.card_id = c.id AND b.status != 'undone')
         AND c.kind IN ('weather', 'alert', 'coming_later')
       ORDER BY c.id DESC LIMIT ?`,
    )
    .all(MAX_TODAY_CARDS);
  const table = bandTable(deps.rules);
  const now = deps.now();
  const views: CardView[] = [];
  for (const card of cards) {
    if (card.kind === "weather") {
      const quote = latestQuote(deps, card.id);
      if (quote !== undefined && quote.settle_at > now) {
        views.push(cardView(card, quote, table));
      }
    } else if (card.created_at + QUIET_CARD_TTL_MS > now) {
      views.push(cardView(card, undefined, table));
    }
  }
  return views;
}
