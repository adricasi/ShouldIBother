import { nameOfBand } from "../../domain/bands.js";
import { CHORES, isChoreType } from "../../domain/chores.js";
import { parseSnapshot } from "../../domain/savings.js";
import { LOSS_COPY, PAID_OUT_STAMP, VERDICT_TITLES } from "../../domain/settle-copy.js";
import type { Verdict } from "../../domain/points.js";
import { bandTable } from "../../domain/rules/index.js";
import {
  RECORDED_WEATHER_LABEL,
  parseWeatherSnapshot,
  type WeatherDigest,
} from "../../domain/weather-digest.js";
import { HttpError } from "../problem.js";

import type { LedgerDeps } from "./deps.js";
import { pointsTotal } from "./points.js";
import type { BetRow, CardRow, ProgressRow, SettlementRow } from "./rows.js";
import { getProgress } from "./settle-progress.js";

/** How the result was proved, in the words of the receipt (AC-010.1). */
const EVIDENCE_TEXT = {
  photo: "After photo, paid in full",
  tap: "One tap, paid at half",
  auto: "Weather record only, paid at half",
} as const;

const EVIDENCE_LABEL = {
  photo: "After photo",
  tap: "One tap",
  auto: "Weather record only",
} as const;

/** What the person gets to read after a bet is settled: PAID OUT receipt or loss screen. */
export interface Receipt {
  readonly bet_id: number;
  readonly title: string;
  readonly kind: "do_nothing" | "do_it";
  /** `paid_out` prints the receipt with the stamp; `loss` and `do_it` print the plain result. */
  readonly outcome: "paid_out" | "loss" | "do_it";
  readonly verdict: Verdict;
  readonly verdict_title: string;
  /** Present on a win only (AC-010.1); never on a loss (AC-010.2). */
  readonly stamp: typeof PAID_OUT_STAMP | null;
  readonly odds: number;
  readonly band_name: string;
  readonly points: number;
  readonly total_points: number;
  readonly multiplier: number;
  /** True when the win was capped at half points because it was settled 24 h or more late. */
  readonly multiplier_capped: boolean;
  readonly evidence: { readonly kind: "photo" | "tap" | "auto"; readonly text: string };
  /** The tap the person gave, in the chore's words. */
  readonly answer: string | null;
  readonly weather: {
    readonly label: string;
    readonly digest: WeatherDigest;
    readonly from: string;
    readonly to: string;
  } | null;
  /** "Gemma's read" (AC-008.4, AC-028.1); null once the photo it read was deleted (AC-015.2). */
  readonly gemma_read: { readonly reason: string; readonly evidence: readonly string[] } | null;
  readonly lucky_win: boolean | null;
  /** The fixed words of a loss or a do-it result (AC-010.2); null on a win. */
  readonly message: string | null;
  /** Savings of a won bet with the assumption behind them (AC-010.1, AC-011.5); null otherwise. */
  readonly saved: {
    readonly time_min: number;
    readonly water_l: number;
    readonly electricity_kwh: number;
    readonly assumption: string;
    readonly basis: string;
  } | null;
  readonly settled_at: string;
}

function readOf(deps: Pick<LedgerDeps, "db">, decisionId: number | null): Receipt["gemma_read"] {
  if (decisionId === null) {
    return null;
  }
  const row = deps.db
    .prepare<[number], { output: string | null }>("SELECT output FROM gemma_decisions WHERE id = ?")
    .get(decisionId);
  if (row?.output === null || row === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.output) as { reason?: unknown; evidence?: unknown };
    if (typeof parsed.reason !== "string") {
      return null;
    }
    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((item): item is string => typeof item === "string")
      : [];
    return { reason: parsed.reason, evidence };
  } catch {
    return null;
  }
}

export function receiptOf(
  deps: Pick<LedgerDeps, "db" | "rules">,
  bet: BetRow,
  card: CardRow,
  settlement: SettlementRow,
  progress: ProgressRow | undefined,
): Receipt {
  const chore = isChoreType(card.chore_type) ? CHORES[card.chore_type] : undefined;
  const verdict = settlement.verdict as Verdict;
  const win = bet.kind === "do_nothing" && verdict === "win";
  const snapshot = parseWeatherSnapshot(settlement.weather);
  const saved = win ? parseSnapshot(bet.savings_snapshot) : null;
  const answerLabel =
    settlement.evidence === "tap"
      ? (chore?.tapAnswers.find((answer) => answer.id === progress?.answer_id)?.label ?? null)
      : null;
  return {
    bet_id: bet.id,
    title: chore?.title ?? card.chore_type,
    kind: bet.kind,
    outcome: win ? "paid_out" : bet.kind === "do_it" ? "do_it" : "loss",
    verdict,
    verdict_title: VERDICT_TITLES[verdict],
    stamp: win ? PAID_OUT_STAMP : null,
    odds: bet.odds,
    band_name: nameOfBand(bandTable(deps.rules), bet.band),
    points: settlement.points,
    total_points: pointsTotal(deps),
    multiplier: settlement.multiplier,
    multiplier_capped: settlement.multiplier_capped === 1,
    evidence: {
      kind: settlement.evidence,
      text:
        bet.kind === "do_it"
          ? "Recorded weather"
          : settlement.multiplier_capped === 1 && verdict === "win"
            ? `${EVIDENCE_LABEL[settlement.evidence]}, paid at half: settled 24 hours or more after the settle time`
            : EVIDENCE_TEXT[settlement.evidence],
    },
    answer: answerLabel,
    weather:
      snapshot === null
        ? null
        : {
            label: RECORDED_WEATHER_LABEL,
            digest: snapshot.digest,
            from: new Date(snapshot.from_ms).toISOString(),
            to: new Date(snapshot.to_ms).toISOString(),
          },
    gemma_read: readOf(deps, settlement.decision_id),
    lucky_win: win && settlement.lucky_win !== null ? settlement.lucky_win === 1 : null,
    message: verdict === "win" ? null : LOSS_COPY[verdict],
    saved:
      saved === null
        ? null
        : {
            time_min: saved.time_min,
            water_l: saved.water_l,
            electricity_kwh: saved.electricity_kwh,
            assumption: saved.assumption,
            basis: saved.basis,
          },
    settled_at: new Date(settlement.settled_at).toISOString(),
  };
}

/** The receipt of a settled bet; 404 for an unknown bet, 409 while it is not settled yet. */
export function getReceipt(deps: Pick<LedgerDeps, "db" | "rules">, betId: number): Receipt {
  const bet = deps.db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(betId);
  if (bet === undefined) {
    throw new HttpError(404, "Bet not found");
  }
  const settlement = deps.db
    .prepare<[number], SettlementRow>(
      "SELECT * FROM settlements WHERE bet_id = ? AND final = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(betId);
  if (settlement === undefined) {
    throw new HttpError(409, "This bet is not settled yet");
  }
  const card = deps.db
    .prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?")
    .get(bet.card_id)!;
  return receiptOf(deps, bet, card, settlement, getProgress(deps.db, bet.id));
}
