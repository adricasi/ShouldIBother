/**
 * The fine-tune dataset (REQ-019, T-031): one JSONL row per chore-day, each the full conversation
 * the live bookmaker has - system prompt, the data message (chore, habits, rule band), the
 * `get_forecast` call and its result - and, for training rows, the answer: the target band from
 * the neighbour method (T-011) with a templated reason and, two or more bands from the rule band,
 * a templated `disagreement_reason`.
 *
 * The conversation is not rebuilt here: each row runs the real `runBookmaker` job against a
 * scripted model and records what the job sent, so the prompt format cannot drift from the live
 * app (AC-019.6), and the target answer must pass the live job's own validation (schema, settle
 * time, the AC-004.3 rule).
 *
 * Hold-out rows (1 Sep to the snapshot's last day) end at the tool result: they carry no answer
 * and no target, only the outcome label for the evaluation (T-014). Output is deterministic
 * (fixed order, no clock): the same snapshot, rules, prompt and habits give the same bytes
 * (NFR-012).
 */

import { createHash } from "node:crypto";

import type { Band } from "../domain/bands.js";
import { CHORES } from "../domain/chores.js";
import {
  BACKTEST_CHORES,
  madridWallTimeToEpochMs,
  type BacktestChore,
} from "../domain/outcomes.js";
import type { RulesConfig } from "../domain/rules/index.js";
import { madridParts } from "../domain/time.js";
import { migrate, openDatabase } from "../server/db.js";
import {
  BAND_NAMES,
  bookmakerOutputSchema,
  distanceFromRule,
  runBookmaker,
  type BandName,
  type BookmakerOutput,
} from "../server/gemma/bookmaker.js";
import { GET_FORECAST } from "../server/gemma/forecast-tool.js";
import type { Prompt } from "../server/gemma/prompts.js";
import { JobRunner, type AnswerMode, type ToolUseMode } from "../server/gemma/runner.js";
import { MIGRATIONS } from "../server/migrations/index.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelClient,
  ModelHealth,
} from "../server/model/client.js";

import {
  buildDataset,
  type Dataset,
  type HoldoutRow,
  type Split,
  type TrainingRow,
} from "./dataset.js";
import { habitsDigest, loadSyntheticHabits, sortedHabits, type Habits } from "./habits.js";
import { TOOL_HORIZON_HOURS, assertNoLookahead, buildCases } from "./harness/cases.js";
import { bookmakerInputFor } from "./harness/gemma-strategy.js";
import type { BacktestCase, DecisionInput } from "./harness/types.js";
import { assertNoHouseholdValues, type HouseholdProbe } from "./household-guard.js";
import { serializeSnapshot, type WeatherSnapshot } from "./snapshot.js";
import { HOLDOUT_START_DATE, TRAINING_END_DATE, TRAINING_START_DATE } from "./target-band.js";

export const FINETUNE_FORMAT_VERSION = 1;
export const TRAIN_FILE = "train.jsonl";
export const HOLDOUT_FILE = "holdout.jsonl";
export const MANIFEST_FILE = "manifest.json";

export class DatasetBuildError extends Error {
  override readonly name = "DatasetBuildError";
}

// ---------------------------------------------------------------------------------------------
// Row format
// ---------------------------------------------------------------------------------------------

/** A chat message in the layout of Hugging Face chat templates (tool calls as OpenAI-style). */
export type TemplateMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls?: readonly {
        readonly type: "function";
        readonly function: { readonly name: string; readonly arguments: Record<string, unknown> };
      }[];
    }
  | { readonly role: "tool"; readonly name: string; readonly content: string };

export function toTemplateMessage(message: ChatMessage): TemplateMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return message.toolCalls === undefined || message.toolCalls.length === 0
        ? { role: "assistant", content: message.content }
        : {
            role: "assistant",
            content: message.content,
            tool_calls: message.toolCalls.map((call) => ({
              type: "function" as const,
              function: { name: call.name, arguments: { ...call.arguments } },
            })),
          };
    case "tool":
      return { role: "tool", name: message.toolName ?? "", content: message.content };
  }
}

export const TEMPLATE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: GET_FORECAST.name,
      description: GET_FORECAST.description,
      parameters: GET_FORECAST.parameters,
    },
  },
];

export interface FinetuneRowMeta {
  readonly prompt_version: string;
  readonly rule_band: BandName;
  readonly forecast_quality: string;
  /** The outcome label ("weather delivered"): the evaluation's truth, never shown to the model. */
  readonly outcome_delivered: boolean;
  /** Training rows only: the neighbour method's target. */
  readonly target?: {
    readonly band: BandName;
    readonly success_rate: number;
    readonly neighbours: number;
    readonly bands_from_rule: number;
  };
}

export interface FinetuneRow {
  readonly id: string;
  readonly split: Split;
  readonly chore: BacktestChore;
  readonly date: string;
  readonly messages: readonly TemplateMessage[];
  readonly tools: typeof TEMPLATE_TOOLS;
  readonly meta: FinetuneRowMeta;
}

// ---------------------------------------------------------------------------------------------
// Templated answer
// ---------------------------------------------------------------------------------------------

function round1(value: number | null | undefined): string {
  return value === null || value === undefined ? "?" : String(Number(value.toFixed(1)));
}

function round2(value: number | null | undefined): string {
  return value === null || value === undefined ? "?" : String(Number(value.toFixed(2)));
}

type Features = Readonly<Record<string, number | null>>;

interface ReasonTemplate {
  readonly facts: (features: Features) => string;
  /** The verdict for each band, index 0 (very unlikely) to 4 (very likely). */
  readonly verdicts: readonly [string, string, string, string, string];
}

const REASONS: Readonly<Record<BacktestChore, ReasonTemplate>> = {
  plants: {
    facts: (f) =>
      `${round1(f["rain_mm"])} mm of rain overnight, up to ${round1(f["max_temperature_c"])} °C`,
    verdicts: [
      "the pots will need water",
      "the pots will probably need water",
      "watering may or may not be needed",
      "the pots should be fine without watering",
      "the pots will be fine without watering",
    ],
  },
  laundry_line: {
    facts: (f) =>
      `${round1(f["wet_hours"])} wet hours and a drying index of ${round2(f["mean_drying_index"])} until 18:00`,
    verdicts: [
      "the washing will not dry outside",
      "the washing may stay damp",
      "it is a coin flip whether it dries",
      "the washing should dry on the line",
      "the washing will dry on the line",
    ],
  },
  laundry_tonight: {
    facts: (f) =>
      `${round1(f["wet_hours"])} wet hours and ${round1(f["dew_hours"])} dew hours overnight`,
    verdicts: [
      "the laundry will be wet by morning",
      "the laundry will probably be damp by morning",
      "it could be damp or dry by morning",
      "the laundry should be dry by morning",
      "the laundry will be dry by morning",
    ],
  },
  ac: {
    facts: (f) =>
      `a night low of ${round1(f["night_min_temperature_c"])} °C and ${round1(f["mean_wind_kmh"])} km/h of wind`,
    verdicts: [
      "it will be too warm without the AC",
      "it will probably be too warm without the AC",
      "the night may be warm",
      "you should sleep fine without the AC",
      "you will sleep fine without the AC",
    ],
  },
  heater: {
    facts: (f) =>
      `a high of ${round1(f["day_max_temperature_c"])} °C and ${round1(f["sunshine_hours"])} h of sun`,
    verdicts: [
      "you will need the heater",
      "you will probably need the heater",
      "you may want the heater",
      "you should be comfortable without the heater",
      "you will be comfortable without the heater",
    ],
  },
};

/** The reason line, templated from the forecast values of the chore's window (not generated). */
export function targetReason(chore: BacktestChore, features: Features, band: Band): string {
  const template = REASONS[chore];
  return `${template.facts(features)}, so ${template.verdicts[band]}`;
}

/** Why the target differs from the rule, from the neighbour counts that produced it. */
export function targetDisagreement(
  successRate: number,
  neighbours: number,
  band: Band,
  ruleBand: Band,
): string {
  const delivered = Math.round(successRate * neighbours);
  const direction = band > ruleBand ? "better" : "worse";
  return `In ${delivered} of ${neighbours} similar days from April to August the weather did the chore, ${direction} odds than the rule's ${BAND_NAMES[ruleBand].replaceAll("_", " ")}.`;
}

/**
 * Hours from the decision to the rule's settle time, rounded down to a tenth: inside the chore's
 * settle bounds, and the rule window (plants run to the settle time) stays what the prompt's rule
 * band was computed over.
 */
export function targetSettleInHours(chore: BacktestChore, decisionAtMs: number): number {
  const hours = (CHORES[chore].ruleSettleAt(decisionAtMs) - decisionAtMs) / 3_600_000;
  return Math.floor(hours * 10 + 1e-9) / 10;
}

// ---------------------------------------------------------------------------------------------
// The live job, scripted
// ---------------------------------------------------------------------------------------------

/**
 * A model that makes the `get_forecast` call when it is offered the tool and then gives a fixed
 * answer. The live `runBookmaker` job runs against it; what the job sent with the answer call is
 * the conversation of the row.
 */
class ScriptedBookmaker implements ModelClient {
  answer = "";
  conversation: readonly ChatMessage[] | undefined;

  chat(request: ChatRequest): Promise<ChatResponse> {
    if ((request.tools?.length ?? 0) > 0) {
      // `hours_ahead: 24` is what the trained model must emit: the backtest serves 24 h of day-1
      // values from the decision hour (TOOL_HORIZON_HOURS), and a larger ask would not see more.
      return Promise.resolve({
        content: "",
        toolCalls: [{ name: GET_FORECAST.name, arguments: { hours_ahead: TOOL_HORIZON_HOURS } }],
        model: "dataset-builder",
      });
    }
    this.conversation = request.messages;
    return Promise.resolve({ content: this.answer, toolCalls: [], model: "dataset-builder" });
  }

  health(): Promise<ModelHealth> {
    return Promise.resolve({ state: "online" });
  }
}

export interface ConversationSource {
  /** The prompt the rows are built with (the frozen `bookmaker.vN`). */
  readonly prompt: Prompt;
  readonly rules: RulesConfig;
  readonly habits: Habits;
  readonly toolUse: ToolUseMode;
  readonly answerMode: AnswerMode;
}

/** Builds conversations by running the live bookmaker job; close it when done. */
export class ConversationBuilder {
  private readonly db = openDatabase(":memory:");
  private readonly model = new ScriptedBookmaker();
  private readonly runner: JobRunner;
  private cardId = 0;

  constructor(private readonly source: ConversationSource) {
    migrate(this.db, MIGRATIONS);
    // Decision rows of the job log carry a made-up card number, as in the backtest.
    this.db.pragma("foreign_keys = OFF");
    this.runner = new JobRunner({
      model: this.model,
      db: this.db,
      now: Date.now,
      toolUse: source.toolUse,
      answerMode: source.answerMode,
    });
  }

  close(): void {
    this.db.close();
  }

  /**
   * The conversation the bookmaker has when it answers `answer` for `input`: the messages the
   * live job sent with its answer call, without the answer itself. Throws `DatasetBuildError` if
   * the live job would not accept the answer.
   */
  async conversation(
    id: string,
    input: DecisionInput,
    answer: BookmakerOutput,
  ): Promise<ChatMessage[]> {
    this.cardId += 1;
    const bookmakerInput = bookmakerInputFor(input, {
      rules: this.source.rules,
      habits: this.source.habits,
      cardId: this.cardId,
    });
    this.model.answer = JSON.stringify(answer);
    this.model.conversation = undefined;
    const result = await runBookmaker(this.runner, bookmakerInput, this.source.prompt);
    if (!result.ok) {
      throw new DatasetBuildError(
        `${id}: the live bookmaker job rejected the target answer (${result.failure}: ${result.error})`,
      );
    }
    if (result.toolMode !== "called" && result.toolMode !== "injected") {
      throw new DatasetBuildError(`${id}: the bookmaker job did not use get_forecast`);
    }
    if (result.retries !== 0 || this.model.conversation === undefined) {
      throw new DatasetBuildError(`${id}: the bookmaker job needed a retry or made no answer call`);
    }
    return [...this.model.conversation];
  }

  /** How far the answer is from the rule band, by the live job's own check. */
  distance(input: DecisionInput, answer: BookmakerOutput): number {
    const bookmakerInput = bookmakerInputFor(input, {
      rules: this.source.rules,
      habits: this.source.habits,
      cardId: 0,
    });
    return distanceFromRule(bookmakerInput, answer) ?? 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/** Why a day that has an outcome label is not a row; every skipped day counts under one reason. */
export type RowSkipReason =
  | "fallback_forecast"
  | "no_decision_input"
  | "safety_alert"
  | "horizon_crosses_split"
  | "no_target";

export const ROW_SKIP_REASONS: readonly RowSkipReason[] = [
  "fallback_forecast",
  "no_decision_input",
  "safety_alert",
  "horizon_crosses_split",
  "no_target",
];

export interface FinetuneOptions extends ConversationSource {
  /** SHA-256 of the text of `config/rules.json` (AC-019.7). */
  readonly rulesSha256: string;
}

export interface BandCounts {
  readonly total: number;
  readonly by_band: Readonly<Record<BandName, number>>;
  readonly delivered: number;
}

export interface SplitCounts {
  readonly rows: number;
  /** Training: bands of the target. Hold-out: bands of the rule (it has no target). */
  readonly band_basis: "target" | "rule";
  readonly by_chore: Readonly<Record<BacktestChore, BandCounts>>;
  readonly skipped: Readonly<Record<RowSkipReason, number>>;
}

export interface Manifest {
  readonly format_version: number;
  readonly bookmaker_prompt: { readonly version: string; readonly sha256: string };
  readonly rules_json_sha256: string;
  readonly snapshot: {
    readonly location: string;
    readonly start_date: string;
    readonly end_date: string;
    readonly requested_end_date: string;
    readonly fetched_at: string;
    readonly sha256: string;
  };
  readonly periods: {
    readonly train: { readonly from: string; readonly to: string };
    readonly holdout: { readonly from: string; readonly to: string };
  };
  readonly habit_profile: Readonly<Record<string, string | boolean>>;
  /**
   * Where the habits come from and what the live app sends: until onboarding feeds the
   * bookmaker, the live data message carries `habits: {}`, while these rows carry the profile.
   */
  readonly habits: {
    readonly profile: "synthetic" | "custom";
    readonly digest: string | null;
    readonly live_sends: "{}";
  };
  readonly conversation: {
    readonly tool_use: ToolUseMode;
    readonly answer_mode: AnswerMode;
    readonly tool_horizon_hours: number;
  };
  readonly rows: { readonly train: SplitCounts; readonly holdout: SplitCounts };
  /** Days with an outcome label that the T-011 dataset itself skipped, by reason. */
  readonly dataset_skips: Readonly<Record<string, number>>;
  readonly features: {
    readonly used: Readonly<Record<BacktestChore, readonly string[]>>;
    readonly dropped: Readonly<Record<BacktestChore, readonly string[]>>;
  };
  readonly files: Readonly<
    Record<
      "train" | "holdout",
      { readonly name: string; readonly rows: number; readonly sha256: string }
    >
  >;
}

export interface FinetuneBuild {
  readonly train: readonly FinetuneRow[];
  readonly holdout: readonly FinetuneRow[];
  readonly trainJsonl: string;
  readonly holdoutJsonl: string;
  readonly manifest: Manifest;
  readonly manifestJson: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function zeroBands(): Record<BandName, number> {
  return Object.fromEntries(BAND_NAMES.map((name) => [name, 0])) as Record<BandName, number>;
}

function countRows(
  rows: readonly FinetuneRow[],
  band: (row: FinetuneRow) => BandName,
  skipped: readonly RowSkipReason[],
  basis: SplitCounts["band_basis"],
): SplitCounts {
  const byChore = {} as Record<BacktestChore, BandCounts>;
  for (const chore of BACKTEST_CHORES) {
    const mine = rows.filter((row) => row.chore === chore);
    const bands = zeroBands();
    for (const row of mine) {
      bands[band(row)] += 1;
    }
    byChore[chore] = {
      total: mine.length,
      by_band: bands,
      delivered: mine.filter((row) => row.meta.outcome_delivered).length,
    };
  }
  return {
    rows: rows.length,
    band_basis: basis,
    by_chore: byChore,
    skipped: Object.fromEntries(
      ROW_SKIP_REASONS.map((reason) => [reason, skipped.filter((r) => r === reason).length]),
    ) as Record<RowSkipReason, number>,
  };
}

/** "2026-10-22 11:00 Europe/Madrid" for an ISO instant; text that is no instant is kept. */
function madridLocal(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  const t = madridParts(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)} Europe/Madrid`;
}

function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

function nameOf(band: Band): BandName {
  return BAND_NAMES[band];
}

/**
 * Builds the training and hold-out rows, the JSONL text and the manifest from a snapshot. Fails
 * with `HouseholdLeakError` (AC-019.8) if any `probes` value appears in a row or the manifest.
 */
export async function buildFinetuneDataset(
  snapshot: WeatherSnapshot,
  options: FinetuneOptions,
  probes: readonly HouseholdProbe[],
): Promise<FinetuneBuild> {
  const dataset: Dataset = buildDataset(snapshot);
  // Day-1 values only: a prompt never carries a Historical Forecast or archive value.
  const built = buildCases(snapshot, options.rules, { fallback: "none" });
  const cases = new Map<string, BacktestCase>(built.cases.map((c) => [c.key, c]));
  const holdoutStartMs = madridWallTimeToEpochMs(HOLDOUT_START_DATE, "00:00");
  const builder = new ConversationBuilder(options);
  const skipped: Record<Split, RowSkipReason[]> = { train: [], holdout: [] };

  const rowFor = async (day: TrainingRow | HoldoutRow): Promise<FinetuneRow | RowSkipReason> => {
    // A day filled from a fallback forecast is not an input of this dataset.
    if (day.forecastQuality !== "day1_previous_runs") {
      return "fallback_forecast";
    }
    const decision = cases.get(`${day.chore}|${day.date}`);
    if (decision === undefined) {
      return "no_decision_input";
    }
    const input = decision.input;
    // The decision is at the chore's fixed time and no value comes from a later model run.
    assertNoLookahead(input);
    if (input.alert !== null) {
      // The backstop answers a "Do it now" alert; the bookmaker is never asked.
      return "safety_alert";
    }
    if (day.split === "train" && input.toolHours.some((hour) => hour.startsAt >= holdoutStartMs)) {
      // The tool shows 24 h ahead: a training prompt must not show any forecast hour of 1 Sep or later.
      return "horizon_crosses_split";
    }
    const id = `${day.chore}|${day.date}`;
    const ruleBand = input.ruleBand;
    const settle = targetSettleInHours(day.chore, input.decisionAtMs);

    let answer: BookmakerOutput;
    let target: FinetuneRowMeta["target"];
    if (day.split === "train") {
      const trained = day.target;
      if (trained.band === null || trained.rate === null) {
        return "no_target";
      }
      const band = trained.band;
      const distance = Math.abs(band - ruleBand);
      target = {
        band: nameOf(band),
        success_rate: trained.rate,
        neighbours: trained.neighbourCount,
        bands_from_rule: distance,
      };
      answer = bookmakerOutputSchema.parse({
        status: "ok",
        band: nameOf(band),
        reason: targetReason(day.chore, day.features, band),
        settle_in_hours: settle,
        ...(distance >= 2
          ? {
              disagreement_reason: targetDisagreement(
                trained.rate,
                trained.neighbourCount,
                band,
                ruleBand,
              ),
            }
          : {}),
      });
      if (builder.distance(input, answer) !== distance) {
        throw new DatasetBuildError(
          `${id}: the live job measures a different distance from the rule band than the dataset`,
        );
      }
    } else {
      // Never part of the row: the live job only needs some valid answer to finish.
      answer = bookmakerOutputSchema.parse({
        status: "ok",
        band: nameOf(ruleBand),
        reason: "placeholder",
        settle_in_hours: settle,
      });
    }

    const conversation = await builder.conversation(id, input, answer);
    const messages = conversation.map(toTemplateMessage);
    if (day.split === "train") {
      messages.push({ role: "assistant", content: JSON.stringify(answer) });
    }
    return {
      id,
      split: day.split,
      chore: day.chore,
      date: day.date,
      messages,
      tools: TEMPLATE_TOOLS,
      meta: {
        prompt_version: options.prompt.version,
        rule_band: nameOf(ruleBand),
        forecast_quality: day.forecastQuality,
        outcome_delivered: day.outcome.delivered,
        ...(target === undefined ? {} : { target }),
      },
    };
  };

  const train: FinetuneRow[] = [];
  const holdout: FinetuneRow[] = [];
  try {
    for (const day of [...dataset.train, ...dataset.holdout]) {
      const row = await rowFor(day);
      if (typeof row === "string") {
        skipped[day.split].push(row);
      } else {
        (day.split === "train" ? train : holdout).push(row);
      }
    }
  } finally {
    builder.close();
  }

  const trainJsonl = toJsonl(train);
  const holdoutJsonl = toJsonl(holdout);
  const manifest: Manifest = {
    format_version: FINETUNE_FORMAT_VERSION,
    bookmaker_prompt: { version: options.prompt.version, sha256: sha256(options.prompt.text) },
    rules_json_sha256: options.rulesSha256,
    snapshot: {
      location: snapshot.location.name,
      start_date: snapshot.startDate,
      end_date: snapshot.endDate,
      requested_end_date: snapshot.requestedEndDate,
      fetched_at: madridLocal(snapshot.fetchedAt),
      sha256: sha256(serializeSnapshot(snapshot)),
    },
    periods: {
      train: { from: TRAINING_START_DATE, to: TRAINING_END_DATE },
      holdout: { from: HOLDOUT_START_DATE, to: snapshot.endDate },
    },
    habit_profile: sortedHabits(options.habits),
    habits: {
      profile:
        habitsDigest(options.habits) === habitsDigest(loadSyntheticHabits())
          ? "synthetic"
          : "custom",
      digest: habitsDigest(options.habits),
      live_sends: "{}",
    },
    conversation: {
      tool_use: options.toolUse,
      answer_mode: options.answerMode,
      tool_horizon_hours: TOOL_HORIZON_HOURS,
    },
    rows: {
      train: countRows(
        train,
        (row) => {
          if (row.meta.target === undefined) {
            throw new DatasetBuildError(`${row.id}: a training row has no target`);
          }
          return row.meta.target.band;
        },
        skipped.train,
        "target",
      ),
      holdout: countRows(holdout, (row) => row.meta.rule_band, skipped.holdout, "rule"),
    },
    dataset_skips: { ...dataset.counts.skipReasons },
    features: { used: dataset.usedFeatures, dropped: dataset.droppedFeatures },
    files: {
      train: { name: TRAIN_FILE, rows: train.length, sha256: sha256(trainJsonl) },
      holdout: { name: HOLDOUT_FILE, rows: holdout.length, sha256: sha256(holdoutJsonl) },
    },
  };

  // AC-019.8: nothing from the household may be in a row, or in the manifest next to them.
  assertNoHouseholdValues(
    [
      ...train.map((row) => ({ id: row.id, value: row })),
      ...holdout.map((row) => ({ id: row.id, value: row })),
      { id: MANIFEST_FILE, value: manifest },
    ],
    probes,
  );

  return {
    train,
    holdout,
    trainJsonl,
    holdoutJsonl,
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}
