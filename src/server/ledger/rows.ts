import type { Band } from "../../domain/bands.js";
import type { BetStatus } from "../../domain/bet-state.js";

export interface CardRow {
  id: number;
  input_text: string;
  chore_type: string;
  kind: "weather" | "not_weather" | "coming_later" | "alert";
  alert_reason: string | null;
  created_at: number;
}

export interface QuoteRow {
  id: number;
  card_id: number;
  source: "rule" | "gemma";
  band: Band;
  odds: number;
  with_photo: number;
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
  verdict: string;
  lucky_win: number | null;
  weather: string | null;
  decision_id: number | null;
  points: number;
  settled_at: number;
  appeal_of: number | null;
  final: number;
}
