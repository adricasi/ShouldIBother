import { z } from "zod";

import {
  ADVICE_CHORES,
  ADVICE_CHORE_TYPES,
  ADVICE_HORIZON_HOURS,
  ADVICE_KINDS,
  ADVICE_MIN_FORECAST_HOURS,
  adviceHeadline,
  advicesDiffer,
  isAdviceChore,
  ruleAdvice,
  ruleReason,
  type Advice,
  type AdviceChore,
} from "../../domain/advice.js";
import { bandTable } from "../../domain/rules/index.js";
import { HOUR_MS } from "../../domain/time.js";
import {
  ADVISOR_CONTRADICTION_PREFIX,
  ADVISOR_PROMPT,
  adviceOf,
  runAdvisor,
  type AdvisorOutput,
} from "../gemma/advisor.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { cardLocationOf, stampCardLocation } from "./card-location.js";
import type { LedgerDeps } from "./deps.js";
import { forecastFrom } from "./forecast.js";
import { decisionView } from "./gemma-facts.js";
import { assertGemmaCapacity } from "./gemma-cards.js";
import type { CardRow } from "./rows.js";
import { FAILURE_NOTES, cardView, type CardView } from "./views.js";

/** The ledger's id for this prompt, kept next to the card so a stored answer says what asked. */
export const ADVICE_PROMPT_VERSION = ADVISOR_PROMPT.version;

const answerSchema = z
  .object({
    advice: z.enum(ADVICE_KINDS),
    window: z
      .object({
        start_hours_ahead: z.number().int().min(0),
        end_hours_ahead: z.number().int().min(1),
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
    rule: answerSchema.nullable(),
    gemma: answerSchema.extend({ reason: z.string() }).strict().nullable(),
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

function writeAdvice(deps: Pick<LedgerDeps, "db">, cardId: number, advice: StoredAdvice): void {
  deps.db.prepare("UPDATE cards SET advice = ? WHERE id = ?").run(JSON.stringify(advice), cardId);
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
 * A new advice card (AC-031.1, flag `adviceCards`): it shows at once as "Gemma is working out
 * when", and the advisor runs in the background like the bookmaker does. The listener found the
 * chore, so this is the normal capture path; no quote, bet, points or savings come with it.
 */
export function createAdviceCard(deps: LedgerDeps, chore: AdviceChore, label: string): CardView {
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

/** The rule's advice, then Gemma's, for one card (REQ-031). Ends with the card out of `thinking`. */
async function adviseCard(deps: LedgerDeps, cardId: number, attempt: number): Promise<void> {
  const card = loadCard(deps, cardId);
  const current = parseAdvice(card);
  if (current === null || card.gemma_state !== "thinking" || current.attempt !== attempt) {
    return;
  }
  // The job's 45 s deadline starts before the forecast is fetched.
  const enqueuedAt = deps.now();
  let hours;
  let fetchedAt;
  try {
    const forecast = await deps.weather.getForecast({
      fromMs: enqueuedAt,
      hours: ADVICE_HORIZON_HOURS,
      ...cardLocationOf(card),
    });
    fetchedAt = forecast.fetchedAt;
    hours = forecastFrom(forecast.hours, enqueuedAt, ADVICE_HORIZON_HOURS);
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      markOffline(deps, cardId, "weather", attempt);
      return;
    }
    throw error;
  }
  const first = hours[0];
  if (first === undefined || hours.length < ADVICE_MIN_FORECAST_HOURS) {
    markOffline(deps, cardId, "weather", attempt);
    return;
  }
  const rule = ruleAdvice(current.chore, hours, deps.adviceRules);
  // The rule's advice is on the card before Gemma answers, so it is there if Gemma never does.
  const withRule: StoredAdvice = {
    ...current,
    rule: toStored(rule),
    gemma: null,
    first_hour_at: first.startsAt,
    forecast_at: fetchedAt,
  };
  writeAdvice(deps, cardId, withRule);

  let result;
  try {
    result = await runAdvisor(
      deps.gemma,
      {
        chore: current.chore,
        label: wordsOf(card, current.chore),
        nowMs: enqueuedAt,
        hours,
        rules: deps.adviceRules,
        cardId,
        enqueuedAt,
      },
      (hoursAhead) => Promise.resolve(forecastFrom(hours, enqueuedAt, hoursAhead)),
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
        writeAdvice(deps, cardId, { ...current, attempt, gemma: null });
      }
      return changes;
    })
    .immediate();
  if (moved === 1) {
    launchAdvisor(deps, cardId, attempt);
  }
  return adviceCardView(deps, cardId);
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
  const state = card.gemma_state ?? "offline";
  const firstHourMs = stored.first_hour_at;
  const rule = stored.rule === null ? null : fromStored(stored.rule);
  const gemma = stored.gemma === null ? null : fromStored(stored.gemma);
  /** "Rule advice" is shown when Gemma has no advice and the rule has; Gemma's wins otherwise. */
  const shown: { source: "gemma" | "rule"; advice: Advice; reason: string } | null =
    gemma !== null && stored.gemma !== null
      ? { source: "gemma", advice: gemma, reason: stored.gemma.reason }
      : rule !== null
        ? { source: "rule", advice: rule, reason: ruleReason(chore, rule, deps.adviceRules) }
        : null;
  const headline = (answer: Advice): string | null =>
    firstHourMs === null ? null : adviceHeadline(chore, answer, firstHourMs, nowMs);
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
    label: shown === null ? null : shown.source === "gemma" ? "Gemma's advice" : "Rule advice",
    advice: shown?.advice.advice ?? null,
    headline: shown === null ? null : headline(shown.advice),
    reason: shown?.reason ?? null,
    window: shown === null ? null : windowOf(shown.advice),
    /** The rule's advice beside Gemma's, only when they differ (AC-031.2). */
    rule:
      differs && rule !== null
        ? { headline: headline(rule), reason: ruleReason(chore, rule, deps.adviceRules) }
        : null,
    /** Why Gemma's advice is not shown, or what Gemma is doing. */
    note: offline
      ? (ADVICE_FAILURE_NOTES[card.gemma_failure ?? "unavailable"] ?? "Gemma is not running.")
      : state === "thinking"
        ? shown === null
          ? "Gemma is checking the forecast."
          : "Gemma is checking the forecast. This is the rule's advice for now."
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
): T & { advice?: AdviceView } {
  const advice = adviceView(deps, card, nowMs);
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
