import type { Band } from "../../domain/bands.js";
import type { BetStatus } from "../../domain/bet-state.js";

export interface CardRow {
  id: number;
  input_text: string;
  chore_type: string;
  kind: "weather" | "not_weather" | "coming_later" | "alert";
  alert_reason: string | null;
  /** Why a card without odds has none (migration 0004). */
  notice: string | null;
  created_at: number;
  /** Null on cards from before migration 0005 (read as "Gemma offline"). */
  gemma_state: "thinking" | "answered" | "question" | "offline" | null;
  gemma_failure: string | null;
  gemma_question: string | null;
  /** JSON list of `{question, yes}`: what Gemma asked and the taps that answered. */
  gemma_answers: string;
  /** Where the before photo stands with the inspector (migration 0006); null without a photo. */
  photo_state: "inspecting" | "seen" | "unsure" | "failed" | null;
  photo_failure: string | null;
  /** The sunset a laundry-tonight card was priced on, epoch ms (migration 0008); null otherwise. */
  sunset_at: number | null;
}

export interface QuoteRow {
  id: number;
  card_id: number;
  source: "rule" | "gemma";
  band: Band;
  odds: number;
  with_photo: number;
  photo_id: string | null;
  reason: string;
  settle_at: number;
  decision_id: number | null;
  created_at: number;
}

export type { BetStatus };

export interface BetRow {
  id: number;
  card_id: number;
  kind: "do_nothing" | "do_it";
  band: Band;
  odds: number;
  odds_source: "rule" | "gemma";
  reason: string;
  gemma_band: Band | null;
  rule_band: Band;
  band_without_photo: Band | null;
  model_version: string | null;
  prompt_version: string | null;
  savings_snapshot: string | null;
  placed_at: number;
  undo_until: number;
  settle_at: number;
  status: BetStatus;
}

export interface SettlementRow {
  id: number;
  bet_id: number;
  evidence: "photo" | "tap" | "auto";
  multiplier: number;
  /** 1 when a settlement 24 h or more after the settle time capped the win at x0.5 (AC-008.8). */
  multiplier_capped: number;
  verdict: string;
  lucky_win: number | null;
  weather: string | null;
  decision_id: number | null;
  points: number;
  settled_at: number;
  appeal_of: number | null;
  final: number;
}

/** What a bet knows while it settles (migration 0007). */
export interface ProgressRow {
  bet_id: number;
  evidence: "tap" | "photo" | null;
  answer_id: string | null;
  photo_id: string | null;
  before_photo_id: string | null;
  answered_at: number | null;
  /** The judge's open yes/no question; null when none waits for an answer (AC-008.5). */
  question: string | null;
  /** JSON list of `{question, yes}`: what the judge asked and the taps that answered. */
  followups: string;
  /** JSON `WeatherSnapshot` the person saw on the settle screen (AC-008.1). */
  weather: string | null;
  tried_at: number | null;
  /** Why the last try did not settle: a judge failure code or `weather`. */
  failure: string | null;
}
