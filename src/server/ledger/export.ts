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

/** The stored onboarding answers; null when there are none (a skip) or the text is unreadable. */
function parseAnswers(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Everything the app keeps about the household's bets, as one JSON document (AC-015.4): cards,
 * quotes, bets with their savings snapshot, settlements with their verdicts and the recorded
 * weather, the person's answers, every Gemma decision, and the totals. Photo files are copied next
 * to it by the command, into the export's `photos/` folder (`photos_dir`); `file` is the bare name.
 * The onboarding answers (`household_profile`) are exported too. Sessions, pairing tokens and the
 * weather cache are not exported: they are not household data.
 */
export function buildExport(db: Db, nowMs: number) {
  const all = <T>(sql: string): T[] => db.prepare<[], T>(sql).all();
  const week = madridWeekOf(nowMs);
  // Bets cashed out at -10 points (REQ-022) have no verdict, so they sit in a table of their own.
  // The key is there only when there are rows: with the `rescue` flag never on, the export is
  // exactly what it was. `rescue_checks` are derived from the forecast and are not exported.
  const cashOuts = all<Record<string, unknown>>("SELECT * FROM cash_outs ORDER BY bet_id");
  // The person's own onboarding answers (flag `onboarding`); the key is there only with a row.
  const profile = db
    .prepare<
      [],
      { status: string; profile: string | null; place_label: string | null; updated_at: number }
    >("SELECT status, profile, place_label, updated_at FROM household_profile WHERE id = 1")
    .get();
  // Unlocked achievements (REQ-025): the key is there only when there are rows, like cash_outs.
  const achievements = all<Record<string, unknown>>("SELECT * FROM achievements ORDER BY id");
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
    ...(cashOuts.length === 0 ? {} : { cash_outs: cashOuts }),
    ...(profile === undefined
      ? {}
      : {
          household_profile: {
            status: profile.status,
            answers: parseAnswers(profile.profile),
            // The place label (AC-026.3) is the person's own text: exported with the answers.
            place_label: profile.place_label,
            updated_at: iso(profile.updated_at),
          },
        }),
    ...(achievements.length === 0 ? {} : { achievements }),
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
