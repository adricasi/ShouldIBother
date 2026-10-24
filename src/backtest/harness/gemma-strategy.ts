/**
 * Gemma as a backtest strategy: the real bookmaker job, driven through `ModelClient`, with the
 * day-1-lead forecast of the decision served as the `get_forecast` result (never live weather).
 * It mirrors the live card flow (`bookmakeCard`): a failed, unsure or unexplained-far answer
 * keeps the rule odds (`odds_source = rule`, excluded from Gemma's calibration) and the fixed
 * backstop turns a dangerous window into a "Do it now" alert whatever Gemma said.
 */

import { CHORES } from "../../domain/chores.js";
import type { RulesConfig } from "../../domain/rules/index.js";
import { safetyAlert } from "../../domain/rules/index.js";
import { openDatabase, migrate, type Db } from "../../server/db.js";
import {
  bandOfName,
  distanceFromRule,
  runBookmaker,
  settleAtOf,
  type BookmakerInput,
} from "../../server/gemma/bookmaker.js";
import { forecastFrom } from "../../server/ledger/forecast.js";
import {
  JobRunner,
  type AnswerMode,
  type JobResult,
  type ToolUseMode,
} from "../../server/gemma/runner.js";
import type { ModelClient } from "../../server/model/client.js";
import { MIGRATIONS } from "../../server/migrations/index.js";

import { ruleBandFor, ruleWindowOf } from "./cases.js";
import { actionForBand } from "./policy.js";
import { RecordingModelClient } from "./recording-model.js";
import {
  type DecisionInput,
  type GemmaFacts,
  type GemmaFallbackReason,
  type Strategy,
  type StrategyDecision,
  type StrategyId,
} from "./types.js";

/** Gemma is not reachable: the run stops and can be resumed, instead of recording rule fallbacks. */
export class ModelOfflineError extends Error {
  override readonly name = "ModelOfflineError";
}

/**
 * The model did not answer in time (a call timeout or the 45 s job deadline). That says more about
 * the laptop than about Gemma, so the run does not record it: it retries the day, and only after
 * the cap does `decision` (the rule odds, as the live app would show) stand.
 */
export class ModelStalledError extends Error {
  override readonly name = "ModelStalledError";
  constructor(
    message: string,
    readonly decision: StrategyDecision,
  ) {
    super(message);
  }
}

/** The runtime answered with another model than the one the config pins. */
export class ModelDigestMismatchError extends Error {
  override readonly name = "ModelDigestMismatchError";
}

/**
 * What the live bookmaker is given for a backtest decision. `sib dataset` builds its rows from the
 * same function, so a fine-tune prompt is exactly what the backtest (and the live app) sends.
 */
export function bookmakerInputFor(
  input: DecisionInput,
  context: {
    readonly rules: RulesConfig;
    readonly habits: Readonly<Record<string, string | boolean>>;
    readonly cardId: number;
  },
): BookmakerInput {
  return {
    chore: input.chore,
    label: CHORES[input.chore].title,
    nowMs: input.decisionAtMs,
    anchorMs: input.decisionAtMs,
    ruleBand: input.ruleBand,
    ruleBandAt: (settleAtMs) =>
      ruleBandFor(
        input,
        ruleWindowOf(input.chore, input.decisionAtMs, input.sunsetMs, settleAtMs),
        context.rules,
      )?.band ?? input.ruleBand,
    answers: [],
    // Only hours the day-1-lead forecast offers at the decision time (24 h from the decision
    // hour, day-1 values only); the lookahead guard has checked their provenance.
    readForecast: (hoursAhead) =>
      Promise.resolve(forecastFrom(input.toolHours, input.decisionAtMs, hoursAhead)),
    cardId: context.cardId,
    habits: context.habits,
  };
}

export interface GemmaStrategyOptions {
  readonly id: Extract<StrategyId, "e2b" | "e4b" | "e4b-ft">;
  readonly model: ModelClient;
  readonly rules: RulesConfig;
  readonly toolUse?: ToolUseMode;
  readonly answerMode?: AnswerMode;
  /** The fixed synthetic profile shown to the bookmaker; never household data. */
  readonly habits?: Readonly<Record<string, string | boolean>>;
  /** Digest pinned in `config/models.json`; a different digest on an answer stops the run. */
  readonly expectedDigest?: string;
  /** Test hooks: shorter limits than the live 30 s / 45 s. */
  readonly callTimeoutMs?: number;
  readonly deadlineMs?: number;
}

export class GemmaStrategy implements Strategy {
  readonly id: GemmaStrategyOptions["id"];
  readonly kind = "gemma" as const;
  private readonly db: Db;
  private readonly runner: JobRunner;
  private readonly recorder: RecordingModelClient;
  private readonly rules: RulesConfig;
  private readonly habits: Readonly<Record<string, string | boolean>>;
  private readonly expectedDigest: string | undefined;
  private cardId = 0;

  constructor(options: GemmaStrategyOptions) {
    this.id = options.id;
    this.rules = options.rules;
    this.habits = options.habits ?? {};
    this.expectedDigest = options.expectedDigest;
    this.recorder = new RecordingModelClient(options.model);
    // The runner logs every job to `gemma_decisions`; the backtest keeps that log in memory and
    // writes its own `decisions.jsonl`.
    this.db = openDatabase(":memory:");
    migrate(this.db, MIGRATIONS);
    // The backtest has no cards: decision rows carry a made-up card number.
    this.db.pragma("foreign_keys = OFF");
    this.runner = new JobRunner({
      model: this.recorder,
      db: this.db,
      now: Date.now,
      ...(options.toolUse === undefined ? {} : { toolUse: options.toolUse }),
      ...(options.answerMode === undefined ? {} : { answerMode: options.answerMode }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    });
  }

  close(): void {
    this.db.close();
  }

  /** Whether the runtime answers; the run waits on this after `ModelOfflineError`. */
  async reachable(): Promise<boolean> {
    return (await this.recorder.health()).state !== "offline";
  }

  /** Gives the GPU back (keep_alive 0): between strategies, on a pause and at the end. */
  async release(): Promise<void> {
    await this.recorder.unload();
  }

  private bookmakerInput(input: DecisionInput): BookmakerInput {
    this.cardId += 1;
    return bookmakerInputFor(input, {
      rules: this.rules,
      habits: this.habits,
      cardId: this.cardId,
    });
  }

  private factsOf(
    result: JobResult<unknown>,
    extra: Pick<GemmaFacts, "failure" | "gemmaBand" | "bandsFromRule">,
  ): GemmaFacts {
    const first = this.recorder.take()[0];
    return {
      model: result.model,
      modelDigest: result.modelDigest ?? null,
      promptVersion: result.promptVersion,
      toolMode: result.toolMode ?? null,
      firstAnswerWithoutTool:
        first === undefined || !first.toolsOffered ? null : first.toolCalls === 0,
      calls: result.calls,
      retries: result.retries,
      latencyMs: result.latencyMs,
      ...extra,
    };
  }

  async decide(input: DecisionInput): Promise<StrategyDecision> {
    if (input.alert !== null) {
      // The backstop overrides Gemma: no job is run for a "Do it now" day.
      return { action: "do_it", basis: "safety_alert", band: null };
    }
    const bookmaker = this.bookmakerInput(input);
    this.recorder.take();
    const result = await runBookmaker(this.runner, bookmaker);

    const fallback = (
      failure: GemmaFallbackReason,
      gemmaBand: GemmaFacts["gemmaBand"] = null,
      bandsFromRule: number | null = null,
    ): StrategyDecision => ({
      action: actionForBand(input.ruleBand),
      basis: "rule_fallback",
      band: input.ruleBand,
      gemma: this.factsOf(result, { failure, gemmaBand, bandsFromRule }),
    });

    if (!result.ok) {
      // The daily call cap exists only in hosted mode; here it would be the model being offline.
      if (
        result.failure === "unavailable" ||
        result.failure === "daily_limit" ||
        result.failure === "busy"
      ) {
        throw new ModelOfflineError(result.error);
      }
      if (result.failure === "timeout" || result.failure === "deadline") {
        throw new ModelStalledError(result.error, fallback(result.failure));
      }
      return fallback(result.failure);
    }
    if (
      this.expectedDigest !== undefined &&
      result.modelDigest !== undefined &&
      result.modelDigest !== this.expectedDigest
    ) {
      throw new ModelDigestMismatchError(
        `${this.id} answered as ${result.modelDigest}, config/models.json pins ${this.expectedDigest}`,
      );
    }
    const output = result.output;
    if (
      output.status !== "ok" ||
      output.band === undefined ||
      output.settle_in_hours === undefined
    ) {
      // A question for the person: nobody answers in a backtest, so the rule odds stand.
      return fallback("unsure");
    }
    const band = bandOfName(output.band);
    const distance = distanceFromRule(bookmaker, output) ?? 0;
    if (distance >= 2 && (output.disagreement_reason ?? "").trim() === "") {
      return fallback("unresolved", band, distance);
    }

    const facts = this.factsOf(result, { failure: null, gemmaBand: band, bandsFromRule: distance });
    const settleAtMs = settleAtOf(
      input.chore,
      bookmaker.anchorMs,
      bookmaker.nowMs,
      output.settle_in_hours,
    );
    const finalWindow = ruleWindowOf(input.chore, input.decisionAtMs, input.sunsetMs, settleAtMs);
    if (safetyAlert(input.hours, finalWindow.startMs, finalWindow.endMs, this.rules) !== null) {
      return { action: "do_it", basis: "safety_alert", band: null, gemma: facts };
    }
    return { action: actionForBand(band), basis: "gemma", band, gemma: facts };
  }
}
