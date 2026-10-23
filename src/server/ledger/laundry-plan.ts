import { z } from "zod";

import { nameOfBand, oddsOfBand, type Band, type BandTable } from "../../domain/bands.js";
import { LAUNDRY_PLAN } from "../../domain/chores.js";
import {
  PLAN_DAY_KEYS,
  PLAN_FORECAST_HOURS,
  PLAN_HEADLINES,
  PLAN_STATES,
  adviceIneligible,
  dryingWindow,
  planDayFacts,
  planIsStale,
  planSettleAt,
  weekdayOf,
  type AdviceReason,
  type PlanState,
} from "../../domain/laundry-plan.js";
import { ADVICE_FOLLOWED_POINTS } from "../../domain/points.js";
import { bandTable, safetyAlert } from "../../domain/rules/index.js";
import { addDays, madridDateOf, madridWallTimeToEpochMs } from "../../domain/time.js";
import { hoursInWindow } from "../../domain/weather.js";
import { bandOfName } from "../gemma/bookmaker.js";
import { distanceFromRule, runLaundryPlanner } from "../gemma/laundry-planner.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { runSafetyGuard } from "../gemma/safety.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { cardLocationOf, stampCardLocation } from "./card-location.js";
import type { LedgerDeps } from "./deps.js";
import { FORECAST_PAST_HOURS, MAX_STORED_ANSWERS, parseAnswers } from "./forecast.js";
import { FAILURE_NOTES, cardView, type CardView } from "./views.js";
import { MAX_QUESTIONS_PER_CARD, assertGemmaCapacity, turnIntoAlert } from "./gemma-cards.js";
import type { CardRow, QuoteRow } from "./rows.js";

/** The planner card's title, and the text of a card made without the person's own words. */
export const PLANNER_TITLE = "Laundry planner";

/** The displayed reason is one line of at most 140 characters (design.md, Gemma jobs). */
const MAX_REASON_CHARS = 140;

const dayKeySchema = z.enum(PLAN_DAY_KEYS);

/** One scored day as stored on the card; the band is Gemma's, the rule band is the code's. */
const storedDaySchema = z
  .object({
    key: dayKeySchema,
    date: z.string(),
    band: z.number().int().min(0).max(4),
    rule_band: z.number().int().min(0).max(4).nullable(),
    rule_reason: z.string().nullable(),
  })
  .strict();

/**
 * The planner card's state (`cards.plan`, migration 0010). `state` is null until Gemma has
 * answered. `need` is the person's answer to "Need anything washed before <day>?" (AC-021.2);
 * `best_day` is the chosen date, computed from Gemma's day key. `anchor_at` is the time the four
 * days hang on (re-set by a Retry on a later day), `forecast_at` when the forecast behind the
 * scores was fetched (a plan is turned into odds only while that is under an hour old), and
 * `attempt` numbers the planner runs of the card, so an old run cannot land over a newer one.
 */
const storedPlanSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(PLAN_STATES).nullable(),
    best_day: z.string().nullable(),
    reason: z.string().nullable(),
    days: z.array(storedDaySchema),
    need: z.enum(["yes", "no"]).nullable(),
    decision_id: z.number().int().nullable(),
    anchor_at: z.number().int(),
    forecast_at: z.number().int().nullable(),
    attempt: z.number().int().min(0),
  })
  .strict();

export type StoredPlan = z.infer<typeof storedPlanSchema>;

function pendingPlan(anchorAt: number): StoredPlan {
  return {
    version: 1,
    state: null,
    best_day: null,
    reason: null,
    days: [],
    need: null,
    decision_id: null,
    anchor_at: anchorAt,
    forecast_at: null,
    attempt: 1,
  };
}

/** The stored plan of a card; null for any card that is not a planner card, or unreadable text. */
export function parsePlan(card: Pick<CardRow, "plan">): StoredPlan | null {
  if (card.plan === null) {
    return null;
  }
  try {
    const result = storedPlanSchema.safeParse(JSON.parse(card.plan));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** True for a card the laundry planner made: the listener's "Coming later" card has no plan. */
export function isPlannerCard(card: Pick<CardRow, "chore_type" | "plan">): boolean {
  return card.chore_type === LAUNDRY_PLAN && card.plan !== null;
}

function loadCard(deps: Pick<LedgerDeps, "db">, cardId: number): CardRow {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  return card;
}

/** The planner card with this id, or 404/409: the planner's own actions never touch other cards. */
function requirePlannerCard(deps: Pick<LedgerDeps, "db">, cardId: number) {
  const card = loadCard(deps, cardId);
  const plan = parsePlan(card);
  if (plan === null) {
    throw new HttpError(409, "This is not a laundry plan");
  }
  return { card, plan };
}

/** True when the id is a planner card (the card routes hand those to the planner). */
export function plannerCardId(deps: Pick<LedgerDeps, "db">, cardId: number): boolean {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  return card !== undefined && isPlannerCard(card);
}

function writePlan(deps: Pick<LedgerDeps, "db">, cardId: number, plan: StoredPlan): void {
  deps.db.prepare("UPDATE cards SET plan = ? WHERE id = ?").run(JSON.stringify(plan), cardId);
}

type CardFailure = keyof typeof FAILURE_NOTES;

/**
 * The planner run `attempt` has no answer: Retry is offered (there are no rule odds to fall back
 * on). Only the card's current run can do this: a run that was overtaken (a restart, then Retry)
 * leaves the newer one alone.
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
       WHERE id = ? AND gemma_state = 'thinking' AND json_extract(plan, '$.attempt') = ?`,
    )
    .run(failure, cardId, attempt);
}

/**
 * Begins a new planner run on a card that is going to `thinking`: numbers it, and re-anchors the
 * four days on now when the card's anchor is from an earlier Madrid day (a Retry the next morning
 * plans today's four days, not yesterday's). Returns the run's number.
 */
function startAttempt(deps: Pick<LedgerDeps, "db" | "now">, cardId: number): number {
  const card = loadCard(deps, cardId);
  const plan = parsePlan(card)!;
  const now = deps.now();
  const anchor = madridDateOf(plan.anchor_at) === madridDateOf(now) ? plan.anchor_at : now;
  const attempt = plan.attempt + 1;
  writePlan(deps, cardId, { ...plan, anchor_at: anchor, attempt });
  return attempt;
}

/**
 * A new laundry planner card (AC-021.1, flag `laundryPlanner`): it shows at once as "Gemma is
 * planning", and the planner runs in the background like the bookmaker does. Wash today, Skip
 * today and No good day are advice on a card with no odds; only Skip today, once the person says
 * nothing needs washing sooner, becomes a card with odds that can be bet on (AC-021.2, AC-021.5).
 */
export function createPlannerCard(deps: LedgerDeps, label?: string): CardView {
  const now = deps.now();
  const plan = pendingPlan(now);
  const id = Number(
    deps.db
      .prepare(
        `INSERT INTO cards (input_text, chore_type, kind, gemma_state, plan, created_at)
         VALUES (?, ?, 'coming_later', 'thinking', ?, ?)`,
      )
      .run(label ?? PLANNER_TITLE, LAUNDRY_PLAN, JSON.stringify(plan), now).lastInsertRowid,
  );
  stampCardLocation(deps, id);
  launchPlanner(deps, id, plan.attempt);
  return plannerCardView(deps, id);
}

/** Starts the planner in the background; the card must be `thinking`. */
function launchPlanner(deps: LedgerDeps, cardId: number, attempt: number): void {
  deps.background.track(
    planCard(deps, cardId, attempt).catch((error: unknown) => {
      markOffline(deps, cardId, "internal", attempt);
      throw error;
    }),
  );
}

/** What the person wrote about the load, or nothing for a card made from the chip. */
function wordsOf(card: CardRow): string {
  return card.input_text === PLANNER_TITLE ? "" : card.input_text;
}

/** Four scored days, from the forecast to the card's plan (REQ-021). Ends with the card out of `thinking`. */
async function planCard(deps: LedgerDeps, cardId: number, attempt: number): Promise<void> {
  const card = loadCard(deps, cardId);
  const current = parsePlan(card);
  if (current === null || card.gemma_state !== "thinking" || current.attempt !== attempt) {
    return;
  }
  // The job's 45 s deadline starts before the forecast is fetched. The four days hang on the
  // plan's anchor, so a Retry after midnight does not move them within the same day.
  const enqueuedAt = deps.now();
  let forecast;
  try {
    forecast = await deps.weather.getForecast({
      fromMs: enqueuedAt,
      hours: PLAN_FORECAST_HOURS,
      pastHours: FORECAST_PAST_HOURS,
      ...cardLocationOf(card),
    });
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      markOffline(deps, cardId, "weather", attempt);
      return;
    }
    throw error;
  }
  const hours = forecast.hours;
  const days = planDayFacts(hours, current.anchor_at, enqueuedAt, deps.rules);
  const answers = parseAnswers(card.gemma_answers);
  const plannerInput = {
    label: wordsOf(card),
    nowMs: enqueuedAt,
    days,
    answers,
    cardId,
    enqueuedAt,
  };
  let result;
  try {
    result = await runLaundryPlanner(deps.gemma, plannerInput);
  } catch (error) {
    if (error instanceof JobQueueFullError) {
      markOffline(deps, cardId, "busy", attempt);
      return;
    }
    throw error;
  }
  if (!result.ok) {
    markOffline(deps, cardId, result.failure, attempt);
    return;
  }
  const { output } = result;
  const mayAsk = answers.length < MAX_QUESTIONS_PER_CARD;
  const ask = (question: string): void => {
    // A card asks at most 2 questions, like the bookmaker's (AC-003.3); then it must answer.
    if (!mayAsk) {
      markOffline(deps, cardId, "unresolved", attempt);
      return;
    }
    deps.db
      .prepare(
        `UPDATE cards SET gemma_state = 'question', gemma_failure = NULL, gemma_question = ?
         WHERE id = ? AND gemma_state = 'thinking' AND json_extract(plan, '$.attempt') = ?`,
      )
      .run(question.trim(), cardId, attempt);
  };
  if (output.status === "unsure") {
    ask(output.question ?? "");
    return;
  }

  // The answer passed the schema: the state, the reason, four scores and the best day are there.
  const state = output.state!;
  const scoreOf = new Map(output.days!.map((entry) => [entry.day, bandOfName(entry.score)]));
  const scored = days.map((day) => ({
    key: day.key,
    date: day.date,
    band: scoreOf.get(day.key)!,
    rule_band: day.ruleBand,
    rule_reason: day.ruleReason,
  }));
  const bestDay =
    output.best_day === undefined ? null : scored.find((d) => d.key === output.best_day)!;
  if (state === "skip_today" && bestDay?.rule_band == null) {
    // A Skip today bet stores the rule band of its day; without one the plan cannot become a bet.
    deps.log({ event: "planner_rule_band_missing", cardId });
    markOffline(deps, cardId, "weather", attempt);
    return;
  }
  // AC-004.3: a Skip today band two or more bands from the rule needs Gemma's explanation, or a
  // question to the person; an unexplained disagreement with a question is asked, not shown.
  const explanation = (output.disagreement_reason ?? "").trim();
  if ((distanceFromRule(plannerInput, output) ?? 0) >= 2 && explanation === "") {
    ask(output.question ?? "");
    return;
  }
  const said = (output.reason ?? "").trim();
  const joined = explanation === "" ? said : `${said} Differs from the rule: ${explanation}`;
  const reason =
    joined.length <= MAX_REASON_CHARS ? joined : `${joined.slice(0, MAX_REASON_CHARS - 1)}…`;
  // Safety is never a bet: if heat, frost or a storm is forecast on the day a Skip today bet
  // would be about, the fixed backstop turns the card into a "Do it now" alert (AC-012.1).
  let alert = null;
  if (state === "skip_today" && bestDay !== null) {
    const window = dryingWindow(bestDay.date, enqueuedAt);
    alert = window === null ? null : safetyAlert(hours, window.fromMs, window.toMs, deps.rules);
  }
  const plan: StoredPlan = {
    ...current,
    state,
    best_day: bestDay?.date ?? null,
    reason,
    days: scored,
    need: null,
    decision_id: result.decisionId,
    forecast_at: forecast.fetchedAt,
  };
  deps.db
    .transaction((): void => {
      const fresh = loadCard(deps, cardId);
      if (fresh.gemma_state !== "thinking" || parsePlan(fresh)?.attempt !== attempt) {
        return;
      }
      writePlan(deps, cardId, plan);
      if (alert !== null) {
        turnIntoAlert(deps, cardId, alert.reason);
        return;
      }
      deps.db
        .prepare(
          `UPDATE cards SET gemma_state = 'answered', gemma_failure = NULL, gemma_question = NULL
           WHERE id = ?`,
        )
        .run(cardId);
    })
    .immediate();
}

/** Retry after "Gemma could not plan" (AC-013.3 applied to the planner). */
export function retryPlanner(deps: LedgerDeps, cardId: number): CardView {
  const { card } = requirePlannerCard(deps, cardId);
  if (card.kind === "alert" || card.gemma_state !== "offline") {
    throw new HttpError(409, "Gemma is not waiting for a retry on this card");
  }
  assertGemmaCapacity(deps);
  const moved = deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'thinking', gemma_failure = NULL
       WHERE id = ? AND gemma_state = 'offline'`,
    )
    .run(cardId).changes;
  if (moved === 1) {
    launchPlanner(deps, cardId, startAttempt(deps, cardId));
  }
  return plannerCardView(deps, cardId);
}

/** The tap on the planner's own yes/no question (the unsure path): remember it and ask again. */
export function answerPlannerQuestion(deps: LedgerDeps, cardId: number, yes: boolean): CardView {
  const { card } = requirePlannerCard(deps, cardId);
  if (card.gemma_state !== "question" || card.gemma_question === null) {
    throw new HttpError(409, "Gemma has no question on this card");
  }
  const stored = parseAnswers(card.gemma_answers);
  if (stored.length >= MAX_STORED_ANSWERS) {
    throw new HttpError(409, "Gemma has asked enough questions on this card");
  }
  assertGemmaCapacity(deps);
  const answers = [...stored, { question: card.gemma_question, yes }];
  const moved = deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'thinking', gemma_question = NULL, gemma_failure = NULL,
         gemma_answers = ?
       WHERE id = ? AND gemma_state = 'question'`,
    )
    .run(JSON.stringify(answers), cardId).changes;
  if (moved === 1) {
    launchPlanner(deps, cardId, startAttempt(deps, cardId));
  }
  return plannerCardView(deps, cardId);
}

/** The stage of a planner card, which decides what the person can do (AC-021.1, AC-021.2). */
export type PlanStage =
  "thinking" | "question" | "offline" | "ask_need" | "wash_today" | "skip_today" | "no_good_day";

/**
 * What is shown now. Gemma's `skip_today` is first a question (AC-021.2): "no" keeps Skip today
 * and opens the bet, "yes" shows Wash today instead.
 */
export function stageOf(card: CardRow, plan: StoredPlan): PlanStage {
  switch (card.gemma_state) {
    case "thinking":
      return "thinking";
    case "question":
      return "question";
    case "offline":
    case null:
      return "offline";
    case "answered":
      break;
  }
  switch (plan.state) {
    case null:
      return "offline";
    case "wash_today":
    case "no_good_day":
      return plan.state;
    case "skip_today":
      if (plan.need === null) {
        return "ask_need";
      }
      return plan.need === "yes" ? "wash_today" : "skip_today";
  }
}

/** "Need anything washed before Thursday?" (AC-021.2), named for the planner's chosen day. */
export function needQuestion(bestDay: string): string {
  return `Need anything washed before ${weekdayOf(bestDay)}?`;
}

/**
 * The person's answer to "Need anything washed before <day>?" (AC-021.2). "Yes" shows Wash today
 * instead. "No" keeps Skip today: the card goes back to `thinking` while the fixed backstop and
 * the Gemma safety guard (flag `safetyGuard`) look at the chosen day on a current forecast, then
 * it becomes a bettable card (see `openSkipBet`). A plan whose forecast is more than an hour old,
 * or whose chosen day has begun, is refused: the person plans the wash again (AC-014.2).
 */
export function answerNeed(deps: LedgerDeps, cardId: number, needed: boolean): CardView {
  const now = deps.now();
  const attempt = deps.db
    .transaction((): number | undefined => {
      const { card, plan } = requirePlannerCard(deps, cardId);
      if (card.kind !== "coming_later" || stageOf(card, plan) !== "ask_need") {
        throw new HttpError(409, "Gemma has no question on this card");
      }
      if (needed) {
        writePlan(deps, cardId, { ...plan, need: "yes" });
        return undefined;
      }
      const chosen = plan.days.find((day) => day.date === plan.best_day);
      if (chosen === undefined || chosen.rule_band === null) {
        throw new HttpError(409, "This plan has no day to bet on");
      }
      if (planIsStale(plan.forecast_at, plan.best_day, now)) {
        throw new HttpError(
          409,
          "This plan is out of date",
          "Plan the wash again: the forecast behind it is more than an hour old, or the day has begun.",
        );
      }
      writePlan(deps, cardId, { ...plan, need: "no" });
      deps.db.prepare("UPDATE cards SET gemma_state = 'thinking' WHERE id = ?").run(cardId);
      return plan.attempt;
    })
    .immediate();
  if (attempt !== undefined) {
    deps.background.track(
      openSkipBet(deps, cardId, attempt).catch((error: unknown) => {
        markOffline(deps, cardId, "internal", attempt);
        throw error;
      }),
    );
  }
  return plannerCardView(deps, cardId);
}

/**
 * Turns a Skip today plan the person said "no" to into a bettable card (AC-021.2, AC-021.5). The
 * fixed backstop is run again on the chosen day with a current forecast, then the Gemma safety
 * guard when its flag is on (AC-012.3): an alert makes the card a "Do it now" alert with no bet.
 * A guard that is offline, busy, late, invalid or unsure lets the bet open (AC-012.4). The quotes
 * are the rule's band for the day and the planner's band for it, settling at 18:00 that day.
 */
async function openSkipBet(deps: LedgerDeps, cardId: number, attempt: number): Promise<void> {
  const { card, plan } = requirePlannerCard(deps, cardId);
  const chosen = plan.days.find((day) => day.date === plan.best_day);
  const window = chosen === undefined ? null : dryingWindow(chosen.date, deps.now());
  if (chosen === undefined || chosen.rule_band === null || window === null) {
    markOffline(deps, cardId, "weather", attempt);
    return;
  }
  const enqueuedAt = deps.now();
  let hours;
  try {
    hours = (
      await deps.weather.getForecast({
        fromMs: enqueuedAt,
        hours: PLAN_FORECAST_HOURS,
        pastHours: FORECAST_PAST_HOURS,
        ...cardLocationOf(card),
      })
    ).hours;
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      markOffline(deps, cardId, "weather", attempt);
      return;
    }
    throw error;
  }
  let alert: { reason: string; event: string } | null = null;
  const backstop = safetyAlert(hours, window.fromMs, window.toMs, deps.rules);
  if (backstop !== null) {
    alert = { reason: backstop.reason, event: "alert_on_final_window" };
  } else if (deps.flags.safetyGuard) {
    try {
      const guard = await runSafetyGuard(deps.gemma, {
        // A Skip today bet is about line-drying the load on the chosen day.
        chore: "laundry_line",
        label: wordsOf(card),
        nowMs: enqueuedAt,
        window,
        forecast: hoursInWindow(hours, window.fromMs, window.toMs).sort(
          (a, b) => a.startsAt - b.startsAt,
        ),
        cardId,
        enqueuedAt,
      });
      if (!guard.ok) {
        deps.log({ event: "safety_guard_unavailable", cardId, failure: guard.failure });
      } else if (guard.output.status === "ok" && guard.output.alert === true) {
        alert = { reason: (guard.output.reason ?? "").trim(), event: "alert_from_safety_guard" };
      }
    } catch (error) {
      deps.log({
        event: "safety_guard_unavailable",
        cardId,
        failure: error instanceof JobQueueFullError ? "busy" : "internal",
      });
    }
  }
  const table = bandTable(deps.rules);
  deps.db
    .transaction((): void => {
      const fresh = loadCard(deps, cardId);
      const freshPlan = parsePlan(fresh);
      if (
        fresh.gemma_state !== "thinking" ||
        freshPlan?.attempt !== attempt ||
        freshPlan.need !== "no"
      ) {
        return;
      }
      if (alert !== null) {
        turnIntoAlert(deps, cardId, alert.reason, alert.event);
        return;
      }
      const now = deps.now();
      const settleAt = planSettleAt(chosen.date);
      const insertQuote = deps.db.prepare(
        `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at,
           decision_id, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      );
      // The rule quote first, so Gemma's is the latest: the bet locks both (AC-004.2).
      insertQuote.run(
        cardId,
        "rule",
        chosen.rule_band,
        oddsOfBand(table, chosen.rule_band as Band),
        chosen.rule_reason ?? "Rule: no reason recorded.",
        settleAt,
        null,
        now,
      );
      insertQuote.run(
        cardId,
        "gemma",
        chosen.band,
        oddsOfBand(table, chosen.band as Band),
        plan.reason ?? "",
        settleAt,
        plan.decision_id,
        now,
      );
      deps.db
        .prepare(
          `UPDATE cards SET kind = 'weather', gemma_state = 'answered', gemma_failure = NULL
           WHERE id = ?`,
        )
        .run(cardId);
    })
    .immediate();
}

/**
 * The person follows Wash today (AC-021.3). Advice is not a bet, so nothing is locked or
 * settled; it earns +5 points when it is followed on the best drying day, before 18:00, once per
 * day. Washing today because something is needed sooner (the "yes" of AC-021.2) follows the advice
 * that was shown, but today is not the best day then, so it earns nothing.
 */
export function followAdvice(deps: LedgerDeps, cardId: number): CardView {
  const now = deps.now();
  deps.db
    .transaction((): void => {
      const { card, plan } = requirePlannerCard(deps, cardId);
      if (card.kind !== "coming_later" || stageOf(card, plan) !== "wash_today") {
        throw new HttpError(409, "There is no Wash today advice on this card");
      }
      if (card.advice_followed_at !== null) {
        throw new HttpError(409, "You already followed this advice");
      }
      const today = madridDateOf(now);
      const earnedToday = deps.db
        .prepare<[number, number], { n: number }>(
          `SELECT COUNT(*) AS n FROM cards
           WHERE advice_points > 0 AND advice_followed_at >= ? AND advice_followed_at < ?`,
        )
        .get(
          madridWallTimeToEpochMs(today, "00:00"),
          madridWallTimeToEpochMs(addDays(today, 1), "00:00"),
        )!.n;
      const eligible = adviceIneligible(plan.state, plan.best_day, now) === null;
      const points = eligible && earnedToday === 0 ? ADVICE_FOLLOWED_POINTS : 0;
      deps.db
        .prepare("UPDATE cards SET advice_followed_at = ?, advice_points = ? WHERE id = ?")
        .run(now, points, cardId);
    })
    .immediate();
  return plannerCardView(deps, cardId);
}

/** Why a followed Wash today earned nothing; null when it earned the points. */
function adviceReasonOf(card: CardRow, plan: StoredPlan): AdviceReason | null {
  if (card.advice_followed_at === null || (card.advice_points ?? 0) > 0) {
    return null;
  }
  return adviceIneligible(plan.state, plan.best_day, card.advice_followed_at) ?? "daily_cap";
}

/** What the client shows of a planner card (`laundry_plan` on the card view). */
export function plannerView(card: CardRow, table: BandTable, nowMs: number) {
  const plan = parsePlan(card);
  if (plan === null) {
    return null;
  }
  const stage = stageOf(card, plan);
  const chosen = plan.days.find((day) => day.date === plan.best_day);
  const shown: PlanState | null =
    stage === "wash_today" || stage === "skip_today" || stage === "no_good_day" ? stage : null;
  const headline =
    stage === "ask_need"
      ? PLAN_HEADLINES.skip_today
      : shown === null
        ? null
        : PLAN_HEADLINES[shown];
  return {
    stage,
    headline,
    reason:
      plan.state === null
        ? null
        : stage === "wash_today" && plan.need === "yes"
          ? `You need washing done before ${weekdayOf(plan.best_day ?? "")}, so wash today.`
          : plan.reason,
    /** Gemma's own yes/no question, or the "Need anything washed" question (AC-021.2). */
    question:
      stage === "question"
        ? card.gemma_question
        : stage === "ask_need" && plan.best_day !== null
          ? needQuestion(plan.best_day)
          : null,
    note:
      stage === "offline"
        ? (FAILURE_NOTES[card.gemma_failure ?? "unavailable"] ?? "Gemma is not running.")
        : stage === "thinking" && plan.state !== null
          ? "Checking that it is safe to wait."
          : null,
    can_retry: stage === "offline",
    /** The plan is too old to open a bet on: the person plans the wash again (AC-014.2). */
    stale: stage === "ask_need" && planIsStale(plan.forecast_at, plan.best_day, nowMs),
    best_day: chosen === undefined ? null : { date: chosen.date, weekday: weekdayOf(chosen.date) },
    /** The four days with Gemma's drying score for each (AC-021.1). */
    days: plan.days.map((day) => ({
      date: day.date,
      weekday: weekdayOf(day.date),
      band: day.band,
      band_name: nameOfBand(table, day.band as Band),
      odds: table.odds[day.band as Band],
    })),
    can_follow: stage === "wash_today" && card.advice_followed_at === null,
    followed: card.advice_followed_at !== null,
    advice_points: card.advice_points,
    /** Why a followed Wash today earned no points: `not_best_day`, `too_late` or `daily_cap`. */
    advice_reason: adviceReasonOf(card, plan),
  };
}

export type PlannerView = NonNullable<ReturnType<typeof plannerView>>;

/** The planner's part of a card view; other cards, and alerts, come back as they were. */
export function withPlan<T extends CardView>(
  card: CardRow,
  view: T,
  table: BandTable,
  nowMs: number,
): T & { laundry_plan?: PlannerView } {
  if (card.kind === "alert") {
    return view;
  }
  const plan = plannerView(card, table, nowMs);
  if (plan === null) {
    return view;
  }
  const words: Record<PlannerView["stage"], string> = {
    thinking: plan.note ?? "Gemma is planning your wash.",
    question: "Gemma has a question about your wash.",
    offline: "Gemma could not plan the wash.",
    ask_need: plan.stale ? "This plan is out of date. Plan the wash again." : (plan.question ?? ""),
    wash_today: `${plan.headline ?? ""}. ${plan.reason ?? ""}`,
    skip_today: `${plan.headline ?? ""}. ${plan.reason ?? ""}`,
    no_good_day: `${plan.headline ?? ""}. ${plan.reason ?? ""}`,
  };
  return {
    ...view,
    title: PLANNER_TITLE,
    notice: card.kind === "coming_later" ? words[plan.stage] : view.notice,
    laundry_plan: plan,
  };
}

/** The card as the client sees it, with the planner's part. */
export function plannerCardView(
  deps: Pick<LedgerDeps, "db" | "rules" | "now">,
  cardId: number,
): ReturnType<typeof withPlan<CardView>> {
  const card = loadCard(deps, cardId);
  const table = bandTable(deps.rules);
  const quote =
    card.kind === "weather"
      ? deps.db
          .prepare<[number], QuoteRow>(
            "SELECT * FROM quotes WHERE card_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(cardId)
      : undefined;
  return withPlan(card, cardView(card, quote, table), table, deps.now());
}
