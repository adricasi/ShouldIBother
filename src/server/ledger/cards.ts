import { oddsOfBand } from "../../domain/bands.js";
import {
  CHORES,
  NOTICES,
  isChoreType,
  laundryTonightNotice,
  laundryTonightOffer,
  offerNotice,
  type ChoreType,
} from "../../domain/chores.js";
import { bandTable, ruleQuote, safetyAlert } from "../../domain/rules/index.js";
import { addDays, madridDateOf } from "../../domain/time.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import type { LedgerDeps } from "./deps.js";
import { cardPhotoView } from "./photo-view.js";
import { launchNewCardJobs } from "./gemma-cards.js";
import { withPlan } from "./laundry-plan.js";
import { latestQuote } from "./quotes.js";
import type { CardRow, QuoteRow } from "./rows.js";
import { cardView, type CardView } from "./views.js";

/** How far ahead the forecast is read; the longest window is "now to next day 12:00". */
const FORECAST_HOURS = 48;
/**
 * Hours before now the rules may need: the AC's night began at 22:00 the evening before (9 to 11
 * hours back at 07:00), and the heater's day at 08:00 (up to 14 hours back at 21:59).
 */
const FORECAST_PAST_HOURS = 24;
const MAX_TODAY_CARDS = 20;
/** Tapping a chip again within this time shows the card that is already there (no stacking). */
const QUIET_CARD_REUSE_MS = 30 * 60 * 1000;

/** Cards without odds (alerts, notices) leave Today after this long; they are not bets in waiting. */
const QUIET_CARD_TTL_MS = 12 * 60 * 60 * 1000;

function insertCard(
  deps: LedgerDeps,
  fields: {
    /** A chore type of this version, or the listener's type for a card that has no odds. */
    readonly choreType: string;
    readonly kind: CardRow["kind"];
    /** What the person wrote about the chore (the listener's label); the chore's title if absent. */
    readonly label?: string;
    readonly alertReason?: string;
    readonly notice?: string;
    /** The sunset a laundry-tonight card is priced on (migration 0008). */
    readonly sunsetAt?: number;
  },
): CardRow {
  const now = deps.now();
  const id = Number(
    deps.db
      .prepare(
        `INSERT INTO cards (input_text, chore_type, kind, alert_reason, notice, gemma_state,
           sunset_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.label ?? (isChoreType(fields.choreType) ? CHORES[fields.choreType].title : ""),
        fields.choreType,
        fields.kind,
        fields.alertReason ?? null,
        fields.notice ?? null,
        // Only a bettable weather card is quoted by Gemma; alerts and notices never are, so the
        // fixed backstop always wins (AC-012.1).
        fields.kind === "weather" ? "thinking" : null,
        fields.sunsetAt ?? null,
        now,
      ).lastInsertRowid,
  );
  return deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(id)!;
}

/**
 * A quiet card (alert or notice) of the same chore and text made in the last 30 minutes, if any:
 * tapping a chip again while Open-Meteo is down, or for "Not needed this season", shows the card
 * that is already there instead of stacking a new one.
 */
function recentQuietCard(
  deps: LedgerDeps,
  choreType: ChoreType,
  kind: "coming_later" | "alert",
  text: string,
): CardRow | undefined {
  const textColumn = kind === "alert" ? "alert_reason" : "notice";
  return deps.db
    .prepare<[string, string, string, number], CardRow>(
      `SELECT * FROM cards WHERE chore_type = ? AND kind = ? AND ${textColumn} = ? AND created_at > ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(choreType, kind, text, deps.now() - QUIET_CARD_REUSE_MS);
}

/**
 * A card with no odds and no bet action that says why (AC-014.4, AC-016.4, AC-016.5). It is stored
 * as kind `coming_later` with the words in `notice`: a client must key on `notice` (the text of
 * "No forecast, can't set odds", "Not needed this season", "Coming later", "offered from 07:00"),
 * not on the kind, which only says "no odds, no bet action".
 */
function noOddsCard(
  deps: LedgerDeps,
  choreType: ChoreType,
  notice: string,
  label?: string,
): CardView {
  const card =
    recentQuietCard(deps, choreType, "coming_later", notice) ??
    insertCard(deps, {
      choreType,
      kind: "coming_later",
      notice,
      ...(label === undefined ? {} : { label }),
    });
  return cardView(card, undefined, bandTable(deps.rules));
}

/**
 * A card from the listener that has no odds and no bet action: "Not a weather chore" (AC-002.2)
 * or "Coming later" for a chore outside this version's list (AC-002.3).
 */
export function createUnbettableCard(
  deps: LedgerDeps,
  kind: "not_weather" | "coming_later",
  listenerType: string,
  label: string,
): CardView {
  const card = insertCard(deps, { choreType: listenerType, kind, label });
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
      // One flag for both seasonal chores: `heater` is the flag the spec names for tier 5's
      // "skip the AC, skip the heater" (REQ-016, Could); there is no separate `ac` flag.
      return deps.flags.heater;
    case "laundry_tonight":
      // Tier 4 (Should): behind its flag, off by default (REQ-029).
      return deps.flags.laundryTonight;
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
 *    Laundry tonight also needs today's sunset from the forecast.
 * 5. Laundry tonight outside 1 h before to 2 h after sunset: says when it can be offered
 *    (AC-016.2). The sunset is stored on the card, and its window starts there.
 * 6. The fixed heat, frost or storm backstop: a "Do it now" alert with its reason, no odds, no bet
 *    action, whatever Gemma would say (AC-012.1).
 * 7. Otherwise the rule band is quoted at once (AC-004.1, AC-013.1): the card and quote are
 *    written together.
 */
export async function createChoreCard(
  deps: LedgerDeps,
  choreType: ChoreType,
  label?: string,
): Promise<CardView> {
  const now = deps.now();
  const chore = CHORES[choreType];
  const table = bandTable(deps.rules);

  if (isNotNeeded(deps, choreType)) {
    return noOddsCard(deps, choreType, NOTICES.notNeeded, label);
  }
  if (!isOfferedYet(deps, choreType)) {
    return noOddsCard(deps, choreType, NOTICES.comingLater, label);
  }
  const offer = chore.offer?.(now);
  if (offer !== undefined && !offer.offered) {
    return noOddsCard(deps, choreType, offerNotice(choreType, now, offer.nextAtMs), label);
  }

  let forecast;
  try {
    forecast = await deps.weather.getForecast({
      fromMs: now,
      hours: FORECAST_HOURS,
      pastHours: FORECAST_PAST_HOURS,
    });
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      return noOddsCard(deps, choreType, NOTICES.noForecast, label);
    }
    throw error;
  }

  // Laundry tonight is priced from sunset to 08:00, so the forecast must know today's sunset and
  // the card is offered only around it (AC-016.2).
  let sunsetMs: number | undefined;
  if (choreType === "laundry_tonight") {
    const today = madridDateOf(now);
    sunsetMs = forecast.sunsetMsByDate[today];
    if (sunsetMs === undefined) {
      return noOddsCard(deps, choreType, NOTICES.noForecast, label);
    }
    if (forecast.sunsetFallbackDates?.includes(today) === true) {
      deps.log({ event: "sunset_fallback", date: today });
    }
    const offer = laundryTonightOffer(now, sunsetMs, forecast.sunsetMsByDate[addDays(today, 1)]);
    if (!offer.offered) {
      return noOddsCard(deps, choreType, laundryTonightNotice(now, offer.nextAtMs), label);
    }
  }

  const window = chore.ruleWindow(now, sunsetMs);
  const alert = safetyAlert(forecast.hours, window.fromMs, window.toMs, deps.rules);
  if (alert !== null) {
    const card =
      recentQuietCard(deps, choreType, "alert", alert.reason) ??
      insertCard(deps, {
        choreType,
        kind: "alert",
        alertReason: alert.reason,
        ...(label === undefined ? {} : { label }),
      });
    return cardView(card, undefined, table);
  }
  const rule = ruleQuote(choreType, forecast.hours, window.fromMs, window.toMs, deps.rules);
  if (rule === null) {
    return noOddsCard(deps, choreType, NOTICES.noForecast, label);
  }

  const insert = deps.db.transaction((): { card: CardRow; quote: QuoteRow } => {
    const card = insertCard(deps, {
      choreType,
      kind: "weather",
      ...(label === undefined ? {} : { label }),
      ...(sunsetMs === undefined ? {} : { sunsetAt: sunsetMs }),
    });
    const quoteId = Number(
      deps.db
        .prepare(
          `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
           VALUES (?, 'rule', ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          card.id,
          rule.band,
          oddsOfBand(table, rule.band),
          rule.reason,
          chore.ruleSettleAt(now),
          now,
        ).lastInsertRowid,
    );
    return {
      card,
      quote: deps.db.prepare<[number], QuoteRow>("SELECT * FROM quotes WHERE id = ?").get(quoteId)!,
    };
  });
  const { card, quote } = insert();
  // Gemma quotes in the background; the person sees the rule odds at once (AC-013.1).
  launchNewCardJobs(deps, card.id);
  return cardView(card, quote, table);
}

/** A quick chip's card (AC-002.5): no listener involved. */
export function createQuickCard(deps: LedgerDeps, choreType: ChoreType): Promise<CardView> {
  return createChoreCard(deps, choreType);
}

export function getCardView(deps: LedgerDeps, cardId: number): CardView {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  const quote = latestQuote(deps, cardId);
  if (card.kind === "weather" && quote === undefined) {
    throw new HttpError(404, "Card not found");
  }
  // An alert has no odds, even if it began as a weather card (its old rule quote stays stored).
  const table = bandTable(deps.rules);
  return withPlan(
    card,
    cardView(
      card,
      card.kind === "weather" ? quote : undefined,
      table,
      cardPhotoView(deps.db, card, table),
    ),
    table,
  );
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
         AND c.kind IN ('weather', 'alert', 'coming_later', 'not_weather')
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
        views.push(
          withPlan(card, cardView(card, quote, table, cardPhotoView(deps.db, card, table)), table),
        );
      }
    } else if (card.created_at + QUIET_CARD_TTL_MS > now) {
      views.push(withPlan(card, cardView(card, undefined, table), table));
    }
  }
  return views;
}
