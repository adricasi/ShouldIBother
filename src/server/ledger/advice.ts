import { z } from "zod";

import {
  ADVICE_CHORES,
  ADVICE_CHORE_TYPES,
  ADVICE_HORIZON_HOURS,
  ADVICE_KINDS,
  ADVICE_MIN_FORECAST_HOURS,
  adviceHeadline,
  adviceWindowOf,
  advicesDiffer,
  isAdviceChore,
  ruleAdvice,
  ruleReason,
  type Advice,
  type AdviceChore,
} from "../../domain/advice.js";

import { bandTable, safetyAlert } from "../../domain/rules/index.js";
import { HOUR_MS } from "../../domain/time.js";
import { hoursInWindow, type ForecastHour } from "../../domain/weather.js";
import {
  ADVISOR_CONTRADICTION_PREFIX,
  ADVISOR_PROMPT,
  MAX_ADVISOR_REASON_CHARS,
  adviceOf,
  runAdvisor,
  type AdvisorOutput,
} from "../gemma/advisor.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { runSafetyGuard } from "../gemma/safety.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { cardLocationOf, stampCardLocation } from "./card-location.js";
import type { LedgerDeps } from "./deps.js";
import { forecastFrom } from "./forecast.js";
import { decisionView, parseForecast, type ForecastRow } from "./gemma-facts.js";
import { assertGemmaCapacity, turnIntoAlert } from "./gemma-cards.js";
import type { CardRow } from "./rows.js";
import { FAILURE_NOTES, cardView, type CardView } from "./views.js";

/** The ledger's id for this prompt, kept next to the card so a stored answer says what asked. */
export const ADVICE_PROMPT_VERSION = ADVISOR_PROMPT.version;

const answerSchema = z
  .object({
    advice: z.enum(ADVICE_KINDS),
    window: z
      .object({
        start_hours_ahead: z.number().int().min(0).max(ADVICE_HORIZON_HOURS),
        end_hours_ahead: z.number().int().min(1).max(ADVICE_HORIZON_HOURS),
      })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * An advice card's state (`cards.advice`, migration 0018). `rule` is the code's advice, computed
 * from the forecast for every card; `gemma` is Gemma's validated answer or null when it has none
 * (offline, refused twice, unsure). `first_hour_at` is the start of forecast hour 0, which both
 * windows count from, and `attempt` numbers the runs of the card so an old run cannot land over a
 * newer one. `decision_id` is the latest advisor decision, kept even when its answer was refused,
 * so "How Gemma decided" can still say what happened.
 */
const storedAdviceSchema = z
  .object({
    version: z.literal(1),
    chore: z.enum(ADVICE_CHORE_TYPES),
    attempt: z.number().int().min(0),
    first_hour_at: z.number().int().nullable(),
    forecast_at: z.number().int().nullable(),
    /** How many forecast hours the advice was made on (72 at most): "no window in the next N h". */
    hours_seen: z.number().int().min(0).max(ADVICE_HORIZON_HOURS).nullable(),
    rule: answerSchema.nullable(),
    gemma: answerSchema
      .extend({ reason: z.string().max(MAX_ADVISOR_REASON_CHARS) })
      .strict()
      .nullable(),
    decision_id: z.number().int().nullable(),
  })
  .strict();

export type StoredAdvice = z.infer<typeof storedAdviceSchema>;
type StoredAnswer = z.infer<typeof answerSchema>;

function pendingAdvice(chore: AdviceChore): StoredAdvice {
  return {
    version: 1,
    chore,
    attempt: 1,
    first_hour_at: null,
    forecast_at: null,
    hours_seen: null,
    rule: null,
    gemma: null,
    decision_id: null,
  };
}

function toStored(answer: Advice): StoredAnswer {
  return {
    advice: answer.advice,
    window:
      answer.window === undefined
        ? null
        : {
            start_hours_ahead: answer.window.startHoursAhead,
            end_hours_ahead: answer.window.endHoursAhead,
          },
  };
}

function fromStored(answer: StoredAnswer): Advice {
  return answer.window === null
    ? { advice: answer.advice }
    : {
        advice: answer.advice,
        window: {
          startHoursAhead: answer.window.start_hours_ahead,
          endHoursAhead: answer.window.end_hours_ahead,
        },
      };
}

/** The stored advice of a card; null for any card that is not an advice card, or unreadable text. */
export function parseAdvice(card: Pick<CardRow, "advice">): StoredAdvice | null {
  if (card.advice === null) {
    return null;
  }
  try {
    const result = storedAdviceSchema.safeParse(JSON.parse(card.advice));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** True for a card the advisor works on: the listener's "Coming later" card has no advice. */
export function isAdviceCard(card: Pick<CardRow, "chore_type" | "advice">): boolean {
  return isAdviceChore(card.chore_type) && card.advice !== null;
}

function loadCard(deps: Pick<LedgerDeps, "db">, cardId: number): CardRow {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  return card;
}

/** True when the id is an advice card (the card routes hand those to the advisor). */
export function adviceCardId(deps: Pick<LedgerDeps, "db">, cardId: number): boolean {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  return card !== undefined && isAdviceCard(card);
}

/**
 * Writes the card's advice, but only over the run it belongs to: a run that was overtaken (a
 * Retry started meanwhile) cannot land over the newer one. `overAttempt` is the attempt stored now;
 * it differs from the advice's own only when a Retry starts a new run.
 */
function writeAdvice(
  deps: Pick<LedgerDeps, "db">,
  cardId: number,
  advice: StoredAdvice,
  overAttempt: number = advice.attempt,
): void {
  deps.db
    .prepare("UPDATE cards SET advice = ? WHERE id = ? AND json_extract(advice, '$.attempt') = ?")
    .run(JSON.stringify(advice), cardId, overAttempt);
}

/** Said when the card shows the rule's advice because Gemma has none: why, in plain words. */
const ADVICE_FAILURE_NOTES: Readonly<Record<string, string>> = {
  ...FAILURE_NOTES,
  invalid: "Gemma's answer did not pass the checks.",
  refused: "Gemma's window was contradicted by the forecast.",
  unsure: "Gemma could not decide from the forecast.",
};

type CardFailure = keyof typeof ADVICE_FAILURE_NOTES;

/**
 * The run `attempt` has no usable Gemma advice: Retry is offered, and the rule's advice stays on
 * the card. Only the card's current run can do this.
 */
function markOffline(
  deps: Pick<LedgerDeps, "db">,
  cardId: number,
  failure: CardFailure,
  attempt: number,
): void {
  deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'offline', gemma_failure = ?, gemma_question = NULL
       WHERE id = ? AND gemma_state = 'thinking' AND json_extract(advice, '$.attempt') = ?`,
    )
    .run(failure, cardId, attempt);
}

/**
 * A new advice card (AC-031.1, flag `adviceCards`): the rule's advice shows at once ("Gemma is
 * thinking · rule advice") and the advisor runs in the background like the bookmaker does. The
 * listener found the chore, so this is the normal capture path; no quote, bet, points or savings
 * come with it. Without a forecast the card is made anyway and says so when the run ends.
 */
export async function createAdviceCard(
  deps: LedgerDeps,
  chore: AdviceChore,
  label: string,
): Promise<CardView> {
  const advice = pendingAdvice(chore);
  const id = Number(
    deps.db
      .prepare(
        `INSERT INTO cards (input_text, chore_type, kind, gemma_state, advice, created_at)
         VALUES (?, ?, 'weather', 'thinking', ?, ?)`,
      )
      .run(label, chore, JSON.stringify(advice), deps.now()).lastInsertRowid,
  );
  stampCardLocation(deps, id);
  try {
    await withRuleAdvice(deps, loadCard(deps, id), advice);
  } catch (error) {
    // The run in the background reports a forecast that is missing; anything else is a bug to log.
    if (!(error instanceof WeatherUnavailableError)) {
      deps.log({ event: "advice_rule_failed", cardId: id });
    }
  }
  launchAdvisor(deps, id, advice.attempt);
  return adviceCardView(deps, id);
}

function launchAdvisor(deps: LedgerDeps, cardId: number, attempt: number): void {
  deps.background.track(
    adviseCard(deps, cardId, attempt).catch((error: unknown) => {
      markOffline(deps, cardId, "internal", attempt);
      throw error;
    }),
  );
}

/** What the person wrote about the chore (the card's text), as the advisor reads it. */
function wordsOf(card: CardRow, chore: AdviceChore): string {
  return card.input_text === ADVICE_CHORES[chore].title ? "" : card.input_text;
}

interface ForecastForAdvice {
  /** The forecast from the hour the card was created in, at most 72 hours. */
  readonly hours: readonly ForecastHour[];
  readonly fetchedAt: number;
}

/**
 * The forecast an advice card works on. Hours are counted from the hour the card was created in,
 * also on a Retry, so a window never moves. Throws `WeatherUnavailableError` when it is not there
 * or covers too few hours to decide.
 */
async function forecastOfCard(deps: LedgerDeps, card: CardRow): Promise<ForecastForAdvice> {
  const forecast = await deps.weather.getForecast({
    fromMs: card.created_at,
    hours: ADVICE_HORIZON_HOURS,
    ...cardLocationOf(card),
  });
  const hours = forecastFrom(forecast.hours, card.created_at, ADVICE_HORIZON_HOURS);
  if (hours.length < ADVICE_MIN_FORECAST_HOURS) {
    throw new WeatherUnavailableError("The forecast covers too few hours for advice");
  }
  return { hours, fetchedAt: forecast.fetchedAt };
}

/** Computes the rule's advice and writes it on the card, with Gemma's answer cleared. */
async function withRuleAdvice(
  deps: LedgerDeps,
  card: CardRow,
  current: StoredAdvice,
): Promise<{ stored: StoredAdvice; forecast: ForecastForAdvice; rule: Advice }> {
  const forecast = await forecastOfCard(deps, card);
  const rule = ruleAdvice(current.chore, forecast.hours, deps.adviceRules);
  const stored: StoredAdvice = {
    ...current,
    rule: toStored(rule),
    gemma: null,
    first_hour_at: forecast.hours[0]!.startsAt,
    forecast_at: forecast.fetchedAt,
    hours_seen: forecast.hours.length,
  };
  writeAdvice(deps, card.id, stored);
  return { stored, forecast, rule };
}

/** The span the safety checks look at for an advice: its window, or the next hours for "do it now". */
function safetySpan(
  deps: Pick<LedgerDeps, "adviceRules">,
  firstHourMs: number,
  answer: Advice,
): { fromMs: number; toMs: number } {
  const window = adviceWindowOf(answer, deps.adviceRules) ?? {
    startHoursAhead: 0,
    endHoursAhead: deps.adviceRules.nowHours,
  };
  return {
    fromMs: firstHourMs + window.startHoursAhead * HOUR_MS,
    toMs: firstHourMs + window.endHoursAhead * HOUR_MS,
  };
}

/** The card becomes a "Do it now" alert if the run is still the card's current one (AC-031.4). */
function alertInstead(
  deps: LedgerDeps,
  cardId: number,
  attempt: number,
  reason: string,
  event: string,
): boolean {
  return deps.db
    .transaction((): boolean => {
      const fresh = loadCard(deps, cardId);
      if (fresh.gemma_state !== "thinking" || parseAdvice(fresh)?.attempt !== attempt) {
        return false;
      }
      turnIntoAlert(deps, cardId, reason, event);
      return true;
    })
    .immediate();
}

/**
 * The Gemma safety guard on an advice card (AC-031.4, flag `safetyGuard`). Returns the alert's
 * reason, or null when there is none, the guard is unsure, away or late (AC-012.4).
 */
async function guardAdvice(
  deps: LedgerDeps,
  card: CardRow,
  chore: AdviceChore,
  span: { fromMs: number; toMs: number },
  hours: readonly ForecastHour[],
): Promise<string | null> {
  const enqueuedAt = deps.now();
  try {
    const result = await runSafetyGuard(deps.gemma, {
      chore,
      label: wordsOf(card, chore),
      nowMs: enqueuedAt,
      window: span,
      forecast: hoursInWindow(hours, span.fromMs, span.toMs).sort(
        (a, b) => a.startsAt - b.startsAt,
      ),
      cardId: card.id,
      enqueuedAt,
    });
    if (!result.ok) {
      deps.log({ event: "safety_guard_unavailable", cardId: card.id, failure: result.failure });
      return null;
    }
    if (result.output.status === "ok") {
      deps.db
        .prepare(
          "UPDATE cards SET safety_checked_at = ? WHERE id = ? AND safety_checked_at IS NULL",
        )
        .run(deps.now(), card.id);
    }
    return result.output.status === "ok" && result.output.alert === true
      ? (result.output.reason ?? "").trim()
      : null;
  } catch (error) {
    deps.log({
      event: "safety_guard_unavailable",
      cardId: card.id,
      failure: error instanceof JobQueueFullError ? "busy" : "internal",
    });
    return null;
  }
}

/**
 * The rule's advice, the safety checks, then Gemma's advice, for one card (REQ-031). Ends with the
 * card out of `thinking`. The fixed backstop and then the guard run before the advisor, and the
 * backstop again on the window Gemma gives; an alert replaces the advice (AC-031.4).
 */
async function adviseCard(deps: LedgerDeps, cardId: number, attempt: number): Promise<void> {
  const card = loadCard(deps, cardId);
  const current = parseAdvice(card);
  if (current === null || card.gemma_state !== "thinking" || current.attempt !== attempt) {
    return;
  }
  const chore = current.chore;
  let prepared;
  try {
    prepared = await withRuleAdvice(deps, card, current);
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      markOffline(deps, cardId, "weather", attempt);
      return;
    }
    throw error;
  }
  const { stored: withRule, forecast, rule } = prepared;
  const hours = forecast.hours;
  const firstHourMs = hours[0]!.startsAt;

  // The fixed backstop on the rule's window, then the guard when its flag is on (AC-031.4).
  const ruleSpan = safetySpan(deps, firstHourMs, rule);
  const backstop = safetyAlert(hours, ruleSpan.fromMs, ruleSpan.toMs, deps.rules);
  if (backstop !== null) {
    alertInstead(deps, cardId, attempt, backstop.reason, "alert_on_final_window");
    return;
  }
  if (deps.flags.safetyGuard) {
    const reason = await guardAdvice(deps, card, chore, ruleSpan, hours);
    if (reason !== null && reason !== "") {
      alertInstead(deps, cardId, attempt, reason, "alert_from_safety_guard");
      return;
    }
  }

  // The job's 45 s deadline starts here.
  const enqueuedAt = deps.now();
  let result;
  try {
    result = await runAdvisor(
      deps.gemma,
      {
        chore,
        label: wordsOf(card, chore),
        nowMs: enqueuedAt,
        hours,
        rules: deps.adviceRules,
        cardId,
        enqueuedAt,
      },
      (hoursAhead) => Promise.resolve(forecastFrom(hours, card.created_at, hoursAhead)),
    );
  } catch (error) {
    if (error instanceof JobQueueFullError) {
      markOffline(deps, cardId, "busy", attempt);
      return;
    }
    throw error;
  }
  const decisionId = result.decisionId;
  if (!result.ok) {
    writeAdvice(deps, cardId, { ...withRule, decision_id: decisionId });
    markOffline(
      deps,
      cardId,
      result.failure === "invalid" && result.error.includes(ADVISOR_CONTRADICTION_PREFIX)
        ? "refused"
        : result.failure,
      attempt,
    );
    return;
  }
  const answer = answerOf(result.output);
  writeAdvice(deps, cardId, { ...withRule, decision_id: decisionId, gemma: answer });
  if (answer === null) {
    // "Unsure": nothing to show of Gemma's, so the rule's advice stands and Retry is offered.
    markOffline(deps, cardId, "unsure", attempt);
    return;
  }
  // The backstop again on the window Gemma chose (AC-031.4).
  const gemmaSpan = safetySpan(deps, firstHourMs, fromStored(answer));
  const final = safetyAlert(hours, gemmaSpan.fromMs, gemmaSpan.toMs, deps.rules);
  if (final !== null) {
    alertInstead(deps, cardId, attempt, final.reason, "alert_on_final_window");
    return;
  }
  deps.db
    .transaction((): void => {
      deps.db
        .prepare(
          `UPDATE cards SET gemma_state = 'answered', gemma_failure = NULL, gemma_question = NULL
           WHERE id = ? AND gemma_state = 'thinking' AND json_extract(advice, '$.attempt') = ?`,
        )
        .run(cardId, attempt);
    })
    .immediate();
}

/** Gemma's answer as stored; null for an `unsure` answer. The reason is cut to one line. */
function answerOf(output: AdvisorOutput): (StoredAnswer & { reason: string }) | null {
  const advice = adviceOf(output);
  return advice === undefined
    ? null
    : { ...toStored(advice), reason: (output.reason ?? "").trim() };
}

/** Retry after "Gemma could not advise" (AC-013.3 applied to the advisor): the rule advice stays meanwhile. */
export function retryAdvice(deps: LedgerDeps, cardId: number): CardView {
  const card = loadCard(deps, cardId);
  const current = parseAdvice(card);
  if (current === null) {
    throw new HttpError(409, "This is not an advice card");
  }
  if (card.gemma_state !== "offline") {
    throw new HttpError(409, "Gemma is not waiting for a retry on this card");
  }
  assertGemmaCapacity(deps);
  const attempt = current.attempt + 1;
  const moved = deps.db
    .transaction((): number => {
      const changes = deps.db
        .prepare(
          `UPDATE cards SET gemma_state = 'thinking', gemma_failure = NULL
           WHERE id = ? AND gemma_state = 'offline'`,
        )
        .run(cardId).changes;
      if (changes === 1) {
        writeAdvice(deps, cardId, { ...current, attempt, gemma: null }, current.attempt);
      }
      return changes;
    })
    .immediate();
  if (moved === 1) {
    launchAdvisor(deps, cardId, attempt);
  }
  return adviceCardView(deps, cardId);
}

/** The most forecast rows the card shows for a window. */
const MAX_WINDOW_ROWS = 24;

const HOUR_LABEL = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Madrid",
});

/**
 * The rows of the stored tool result that fall in the advice's window, each named by its Madrid
 * day and hour. Rows are counted from the first forecast hour, like the window. Empty without a
 * stored decision or for "no window".
 */
function windowForecast(
  db: LedgerDeps["db"],
  decisionId: number | null,
  firstHourMs: number,
  answer: Advice,
  rules: LedgerDeps["adviceRules"],
): ForecastRow[] {
  const window = adviceWindowOf(answer, rules);
  if (decisionId === null || window === undefined) {
    return [];
  }
  const row = db
    .prepare<[number], { tool_result: string | null }>(
      "SELECT tool_result FROM gemma_decisions WHERE id = ?",
    )
    .get(decisionId);
  const from = window.startHoursAhead;
  const rows = parseForecast(
    row?.tool_result ?? null,
    from,
    Math.min(window.endHoursAhead, from + MAX_WINDOW_ROWS),
  );
  return (rows ?? []).map((entry, index) => ({
    ...entry,
    hour: HOUR_LABEL.format(firstHourMs + (from + index) * HOUR_MS).replace(",", ""),
  }));
}

/** What the client shows of an advice card (`advice` on the card view). */
export function adviceView(
  deps: Pick<LedgerDeps, "db" | "adviceRules">,
  card: CardRow,
  nowMs: number,
): AdviceView | null {
  const stored = parseAdvice(card);
  if (stored === null) {
    return null;
  }
  const chore = stored.chore;
  const hoursSeen = stored.hours_seen ?? ADVICE_HORIZON_HOURS;
  const state = card.gemma_state ?? "offline";
  const firstHourMs = stored.first_hour_at;
  const rule = stored.rule === null ? null : fromStored(stored.rule);
  const gemma = stored.gemma === null ? null : fromStored(stored.gemma);
  /** "Rule advice" is shown when Gemma has no advice and the rule has; Gemma's wins otherwise. */
  const shown: { source: "gemma" | "rule"; advice: Advice; reason: string } | null =
    gemma !== null && stored.gemma !== null
      ? { source: "gemma", advice: gemma, reason: stored.gemma.reason }
      : rule !== null
        ? {
            source: "rule",
            advice: rule,
            reason: ruleReason(chore, rule, deps.adviceRules, hoursSeen),
          }
        : null;
  const headline = (answer: Advice): string | null =>
    firstHourMs === null ? null : adviceHeadline(chore, answer, firstHourMs, nowMs, hoursSeen);
  const windowOf = (answer: Advice) =>
    answer.window === undefined || firstHourMs === null
      ? null
      : {
          from: new Date(firstHourMs + answer.window.startHoursAhead * HOUR_MS).toISOString(),
          to: new Date(firstHourMs + answer.window.endHoursAhead * HOUR_MS).toISOString(),
        };
  const differs =
    shown?.source === "gemma" && rule !== null ? advicesDiffer(shown.advice, rule) : false;
  const offline = state === "offline";
  return {
    chore,
    stage: shown === null ? (offline ? "unavailable" : "thinking") : "advice",
    source: shown?.source ?? null,
    /** "Gemma's advice" or "Rule advice" (AC-031.2). */
    label:
      shown === null
        ? null
        : shown.source === "gemma"
          ? "Gemma's advice"
          : state === "thinking"
            ? "Rule advice · Gemma is thinking"
            : "Rule advice",
    advice: shown?.advice.advice ?? null,
    headline: shown === null ? null : headline(shown.advice),
    reason: shown?.reason ?? null,
    window: shown === null ? null : windowOf(shown.advice),
    /** The forecast numbers Gemma was given for the window, from the stored decision (AC-031.1). */
    forecast:
      shown === null || firstHourMs === null
        ? []
        : windowForecast(deps.db, stored.decision_id, firstHourMs, shown.advice, deps.adviceRules),
    /** The window's length in hours, so the card can say when the numbers cover less of it. */
    forecast_total: (() => {
      const window = shown === null ? undefined : adviceWindowOf(shown.advice, deps.adviceRules);
      return window === undefined ? 0 : window.endHoursAhead - window.startHoursAhead;
    })(),
    /** The rule's advice beside Gemma's, only when they differ (AC-031.2). */
    rule:
      differs && rule !== null
        ? { headline: headline(rule), reason: ruleReason(chore, rule, deps.adviceRules, hoursSeen) }
        : null,
    /** Why Gemma's advice is not shown, or what Gemma is doing. */
    note: offline
      ? (ADVICE_FAILURE_NOTES[card.gemma_failure ?? "unavailable"] ?? "Gemma is not running.")
      : state === "thinking" && shown === null
        ? "Gemma is checking the forecast."
        : null,
    can_retry: offline,
    /** "How Gemma decided" (AC-028.4, AC-031.3): the advisor decision behind the card. */
    decision: decisionView(deps.db, stored.decision_id),
  };
}

export type AdviceView = {
  readonly chore: AdviceChore;
  readonly stage: "thinking" | "unavailable" | "advice";
  readonly source: "gemma" | "rule" | null;
  readonly label: string | null;
  readonly advice: (typeof ADVICE_KINDS)[number] | null;
  readonly headline: string | null;
  readonly reason: string | null;
  readonly window: { readonly from: string; readonly to: string } | null;
  readonly rule: { readonly headline: string | null; readonly reason: string } | null;
  readonly forecast: ForecastRow[];
  readonly forecast_total: number;
  readonly note: string | null;
  readonly can_retry: boolean;
  readonly decision: ReturnType<typeof decisionView>;
};

/** The advice part of a card view; other cards come back as they were. */
export function withAdvice<T extends CardView>(
  deps: Pick<LedgerDeps, "db" | "adviceRules">,
  card: CardRow,
  view: T,
  nowMs: number,
): T & { advice?: AdviceView; advice_alert?: true } {
  const advice = adviceView(deps, card, nowMs);
  if (advice !== null && card.kind === "alert") {
    // The safety backstop or guard replaced the advice (AC-031.4): the card is an alert, and the
    // client says "Not safe today" with the chore's name rather than the person's words.
    return { ...view, title: ADVICE_CHORES[advice.chore].title, advice_alert: true };
  }
  if (advice === null || card.kind !== "weather") {
    return view;
  }
  return {
    ...view,
    title: ADVICE_CHORES[advice.chore].title,
    notice: advice.headline ?? advice.note ?? view.notice,
    advice,
  };
}

/** The card as the client sees it, with the advice part. */
export function adviceCardView(
  deps: Pick<LedgerDeps, "db" | "rules" | "now" | "adviceRules">,
  cardId: number,
): ReturnType<typeof withAdvice<CardView>> {
  const card = loadCard(deps, cardId);
  return withAdvice(deps, card, cardView(card, undefined, bandTable(deps.rules)), deps.now());
}

/**
 * When an advice card leaves Today: at the end of the window it advises (a "do it now" is the first
 * hours, a wait its window), and 72 hours after it was made for "no window" and for a card with no
 * advice yet (REQ-031).
 */
export function adviceExpiresAt(card: CardRow, rules: LedgerDeps["adviceRules"]): number {
  const stored = parseAdvice(card);
  const fallback = card.created_at + ADVICE_HORIZON_HOURS * HOUR_MS;
  if (stored === null || stored.first_hour_at === null) {
    return fallback;
  }
  const shown =
    stored.gemma !== null
      ? fromStored(stored.gemma)
      : stored.rule !== null
        ? fromStored(stored.rule)
        : null;
  if (shown === null || shown.advice === "no_window") {
    return fallback;
  }
  const window = adviceWindowOf(shown, rules);
  return window === undefined ? fallback : stored.first_hour_at + window.endHoursAhead * HOUR_MS;
}
