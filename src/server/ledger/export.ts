import { parseSnapshot } from "../../domain/savings.js";
import { madridWeekOf } from "../../domain/week.js";
import { parseWeatherSnapshot } from "../../domain/weather-digest.js";
import type { Db } from "../db.js";

import { pointsTotal } from "./points.js";
import { savingsTotals } from "./savings.js";
import type { BetRow, ProgressRow, SettlementRow } from "./rows.js";
import { parseFollowups } from "./settle-progress.js";

/** Version of the export file's shape. */
export const EXPORT_VERSION = 1;
/** The folder of the export that holds the photo files. */
export const EXPORT_PHOTOS_DIR = "photos";

interface PhotoExportRow {
  id: string;
  card_id: number | null;
  bet_id: number | null;
  role: string;
  file: string;
  received_at: number;
  width: number;
  height: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Everything the app keeps about the household's bets, as one JSON document (AC-015.4): cards,
 * quotes, bets with their savings snapshot, settlements with their verdicts and the recorded
 * weather, the person's answers, every Gemma decision, and the totals. Photo files are copied next
 * to it by the command, into the export's `photos/` folder (`photos_dir`); `file` is the bare name.
 * Sessions, pairing tokens and the weather cache are not exported: they are not household data.
 */
export function buildExport(db: Db, nowMs: number) {
  const all = <T>(sql: string): T[] => db.prepare<[], T>(sql).all();
  const week = madridWeekOf(nowMs);
  return {
    version: EXPORT_VERSION,
    exported_at: iso(nowMs),
    cards: all<Record<string, unknown>>("SELECT * FROM cards ORDER BY id"),
    quotes: all<Record<string, unknown>>("SELECT * FROM quotes ORDER BY id"),
    bets: all<BetRow>("SELECT * FROM bets ORDER BY id").map((bet) => ({
      ...bet,
      savings_snapshot: parseSnapshot(bet.savings_snapshot),
    })),
    verdicts: all<SettlementRow>("SELECT * FROM settlements ORDER BY id").map((settlement) => ({
      ...settlement,
      weather: parseWeatherSnapshot(settlement.weather),
    })),
    // Bets cashed out at -10 points (REQ-022): a closed bet with no verdict, so a table of its own.
    cash_outs: all<Record<string, unknown>>("SELECT * FROM cash_outs ORDER BY bet_id"),
    answers: all<ProgressRow>("SELECT * FROM settle_progress ORDER BY bet_id").map((progress) => ({
      bet_id: progress.bet_id,
      evidence: progress.evidence,
      answer_id: progress.answer_id,
      photo_id: progress.photo_id,
      before_photo_id: progress.before_photo_id,
      answered_at: progress.answered_at === null ? null : iso(progress.answered_at),
      question: progress.question,
      followups: parseFollowups(progress.followups),
    })),
    decisions: all<Record<string, unknown>>("SELECT * FROM gemma_decisions ORDER BY id"),
    photos_dir: EXPORT_PHOTOS_DIR,
    photos: all<PhotoExportRow>("SELECT * FROM photos ORDER BY received_at, id").map((photo) => ({
      id: photo.id,
      card_id: photo.card_id,
      bet_id: photo.bet_id,
      role: photo.role,
      file: photo.file,
      width: photo.width,
      height: photo.height,
      received_at: iso(photo.received_at),
    })),
    totals: {
      points: pointsTotal({ db }),
      savings: savingsTotals({ db }),
      this_week: { from: week.fromDate, to: week.toDate, savings: savingsTotals({ db }, week) },
    },
  };
}

export type HouseholdExport = ReturnType<typeof buildExport>;
