import type { Band, BandTable } from "../../domain/bands.js";
import { nameOfBand, oddsOfBand } from "../../domain/bands.js";
import { bandTable } from "../../domain/rules/index.js";
import type { Db } from "../db.js";

import type { BetRow, CardRow } from "./rows.js";

/** A band with its words and odds, as the surfaces show it side by side (AC-028.3). */
export interface BandFact {
  readonly band: Band;
  readonly band_name: string;
  readonly odds: number;
}

export function bandFact(table: BandTable, band: Band): BandFact {
  return { band, band_name: nameOfBand(table, band), odds: oddsOfBand(table, band) };
}

/** One hour of the forecast Gemma was given: local hour, rain, chance of rain, temperature, wind, sunshine. */
export interface ForecastRow {
  readonly hour: string;
  readonly rain_mm: number | null;
  readonly rain_prob_pct: number | null;
  readonly temp_c: number | null;
  readonly wind_kmh: number | null;
  readonly sunshine_min: number | null;
}

/** The rows the disclosure shows by default; the rest stay in the database. */
const SHOWN_HOURS = 6;

/**
 * What the "How Gemma decided" disclosure shows of one `gemma_decisions` row (AC-028.4): the model
 * tag and a short digest, the prompt version, whether the forecast tool was called, the forecast
 * hours it returned, retries and latency. `input_summary`, the raw output and any household text
 * stay out of it; nothing here leaves the laptop.
 */
export interface DecisionView {
  readonly job: string;
  readonly model: string;
  /** True for the fixture model of tests and `SIB_FAKE_MODEL`: the disclosure says so. */
  readonly fake: boolean;
  readonly digest: string | null;
  readonly prompt_version: string;
  readonly tool_mode: "called" | "injected" | "missed" | null;
  readonly forecast: ForecastRow[] | null;
  readonly retries: number;
  readonly latency_ms: number;
}

interface DecisionRow {
  job: string;
  model: string;
  model_digest: string | null;
  prompt_version: string;
  tool_mode: "called" | "injected" | "missed" | null;
  tool_result: string | null;
  retries: number;
  latency_ms: number;
}

const COLUMNS =
  "job, model, model_digest, prompt_version, tool_mode, tool_result, retries, latency_ms";

/** "sha256:3f9a…" becomes "3f9a1c2d4e5f": the first 12 characters, the part people compare. */
export function shortDigest(digest: string | null): string | null {
  if (digest === null || digest === "") {
    return null;
  }
  return digest.replace(/^sha256:/, "").slice(0, 12);
}

function parseForecast(text: string | null): ForecastRow[] | null {
  if (text === null) {
    return null;
  }
  try {
    const rows = JSON.parse(text) as unknown;
    if (!Array.isArray(rows)) {
      return null;
    }
    const number = (value: unknown): number | null => (typeof value === "number" ? value : null);
    return rows.slice(0, SHOWN_HOURS).flatMap((row: unknown) => {
      if (!Array.isArray(row) || typeof row[0] !== "string") {
        return [];
      }
      return [
        {
          hour: row[0],
          rain_mm: number(row[1]),
          rain_prob_pct: number(row[2]),
          temp_c: number(row[3]),
          wind_kmh: number(row[4]),
          sunshine_min: number(row[5]),
        },
      ];
    });
  } catch {
    return null;
  }
}

function viewOf(row: DecisionRow): DecisionView {
  return {
    job: row.job,
    model: row.model,
    fake: /^fake/i.test(row.model),
    digest: shortDigest(row.model_digest),
    prompt_version: row.prompt_version,
    tool_mode: row.tool_mode,
    forecast: parseForecast(row.tool_result),
    retries: row.retries,
    latency_ms: row.latency_ms,
  };
}

/** The decision with this id, or null when there is none (the id is null, or the row was deleted). */
export function decisionView(db: Db, decisionId: number | null): DecisionView | null {
  if (decisionId === null) {
    return null;
  }
  const row = db
    .prepare<[number], DecisionRow>(`SELECT ${COLUMNS} FROM gemma_decisions WHERE id = ?`)
    .get(decisionId);
  return row === undefined ? null : viewOf(row);
}

/**
 * The decision that priced a bet on Gemma's odds: the card's last valid pricing decision made
 * before the bet was placed. Null for a bet on rule odds, which Gemma did not set.
 */
export function pricingDecisionOf(
  db: Db,
  bet: BetRow,
  card: Pick<CardRow, "id">,
): DecisionView | null {
  if (bet.odds_source !== "gemma") {
    return null;
  }
  const row = db
    .prepare<[number, number], DecisionRow>(
      `SELECT ${COLUMNS} FROM gemma_decisions
       WHERE card_id = ? AND job IN ('bookmaker', 'laundry-planner') AND valid = 1 AND created_at <= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(card.id, bet.placed_at);
  return row === undefined ? null : viewOf(row);
}

interface QuoteFacts {
  source: "rule" | "gemma";
  decision_id: number | null;
}

/**
 * What a card with odds adds to its view for AC-028.3 and AC-028.4: the rule's band next to the
 * quote (so a disagreement can show both bands), and the decision behind a quote of Gemma's. A
 * quote of the rule has no Gemma decision to disclose.
 */
export function withGemmaFacts<T extends { readonly quote: { readonly id: number } | null }>(
  deps: { readonly db: Db; readonly rules: Parameters<typeof bandTable>[0] },
  card: { readonly id: number },
  view: T,
): T & { rule?: BandFact; decision?: DecisionView | null } {
  if (view.quote === null) {
    return view;
  }
  const quote = deps.db
    .prepare<[number], QuoteFacts>("SELECT source, decision_id FROM quotes WHERE id = ?")
    .get(view.quote.id);
  const ruleQuote = deps.db
    .prepare<[number], { band: Band }>(
      "SELECT band FROM quotes WHERE card_id = ? AND source = 'rule' ORDER BY id DESC LIMIT 1",
    )
    .get(card.id);
  if (quote === undefined || ruleQuote === undefined) {
    return view;
  }
  return {
    ...view,
    rule: bandFact(bandTable(deps.rules), ruleQuote.band),
    decision: quote.source === "gemma" ? decisionView(deps.db, quote.decision_id) : null,
  };
}
