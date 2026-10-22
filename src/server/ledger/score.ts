import {
  calibrationBands,
  type BandCount,
  type CalibrationBand,
} from "../../domain/calibration.js";
import { bandTable } from "../../domain/rules/index.js";
import type { SavingsTotals } from "../../domain/savings.js";

import type { LedgerDeps } from "./deps.js";
import { luckyWinShare, type LuckyShare } from "./lucky.js";
import { pointsTotal } from "./points.js";
import { savingsTotals } from "./savings.js";

type ScoreDeps = Pick<LedgerDeps, "db" | "rules" | "flags" | "now">;

/** How often the user overruled the judge (product.md, Judge agreement). */
export type JudgeOverrule =
  /** REQ-023 is disabled: the judge was never checked, and the screen says so (AC-020.1). */
  | { readonly appeals: "off" }
  | {
      readonly appeals: "on";
      /** Gemma verdicts on do-nothing bets that were settled. */
      readonly n: number;
      /** Appeals whose second, final verdict differs from the first. */
      readonly overruled: number;
      readonly rate_pct: number | null;
    };

export interface Score {
  readonly now: string;
  readonly points: { readonly total: number };
  /** All time, every bet (REQ-011): wins skipped a chore, net time subtracts 30 s per bet. */
  readonly savings: SavingsTotals;
  readonly judge: JudgeOverrule;
  readonly calibration: {
    /** Settled do-nothing bets: the population of both charts. Zero shows the empty state. */
    readonly settled: number;
    /** Predicted odds of Gemma's band against how often doing nothing worked (AC-020.2). */
    readonly gemma: readonly CalibrationBand[];
    /** The same for the rule's band, over every settled do-nothing bet. */
    readonly rule: readonly CalibrationBand[];
    readonly lucky_wins: LuckyShare;
  };
}

/**
 * The final settlement of each bet. A bet has one original row; an appeal adds a second, and only
 * one of the two is final (REQ-023), so the latest final row is the bet's result.
 */
const FINAL_SETTLEMENT = `JOIN settlements s ON s.id = (
  SELECT MAX(id) FROM settlements WHERE bet_id = b.id AND final = 1
)`;

/** Settled bets on doing nothing: do-it decisions, cash-outs and undone bets are not in it. */
const SETTLED_DO_NOTHING = "b.kind = 'do_nothing' AND b.status = 'settled'";

/**
 * Gemma's population: bets priced by Gemma, counted under the band Gemma gave. A bet whose
 * model_version names the fake model is a fixture, not Gemma (decisions.ts), so it is left out.
 */
const GEMMA_PRICED = `b.odds_source = 'gemma' AND b.gemma_band IS NOT NULL
  AND (b.model_version IS NULL OR b.model_version NOT LIKE 'fake%')`;

function countsBy(deps: Pick<LedgerDeps, "db">, bandColumn: string, extra: string): BandCount[] {
  return deps.db
    .prepare<[], BandCount>(
      `SELECT b.${bandColumn} AS band, COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN s.verdict = 'win' THEN 1 ELSE 0 END), 0) AS wins
       FROM bets b ${FINAL_SETTLEMENT}
       WHERE ${SETTLED_DO_NOTHING} ${extra}
       GROUP BY b.${bandColumn}`,
    )
    .all();
}

function overruleOf(deps: ScoreDeps): JudgeOverrule {
  if (!deps.flags.appeals) {
    return { appeals: "off" };
  }
  const n = deps.db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM bets b
       WHERE ${SETTLED_DO_NOTHING}
         AND EXISTS (SELECT 1 FROM settlements o WHERE o.bet_id = b.id AND o.appeal_of IS NULL)`,
    )
    .get()!.n;
  const overruled = deps.db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM settlements a
       JOIN settlements o ON o.id = a.appeal_of
       JOIN bets b ON b.id = a.bet_id
       WHERE a.final = 1 AND ${SETTLED_DO_NOTHING} AND a.verdict != o.verdict`,
    )
    .get()!.n;
  return {
    appeals: "on",
    n,
    overruled,
    rate_pct: n === 0 ? null : Math.round((overruled / n) * 100),
  };
}

/** The Score screen's numbers (REQ-020), read from the stored rows only. */
export function getScore(deps: ScoreDeps): Score {
  const table = bandTable(deps.rules);
  const gemma = countsBy(deps, "gemma_band", `AND ${GEMMA_PRICED}`);
  // The rule is scored on every settled do-nothing bet, whoever priced it (AC-020.2).
  const rule = countsBy(deps, "rule_band", "");
  return {
    now: new Date(deps.now()).toISOString(),
    points: { total: pointsTotal(deps) },
    savings: savingsTotals(deps),
    judge: overruleOf(deps),
    calibration: {
      settled: rule.reduce((sum, entry) => sum + entry.n, 0),
      gemma: calibrationBands(table, gemma),
      rule: calibrationBands(table, rule),
      lucky_wins: luckyWinShare(deps.db),
    },
  };
}
