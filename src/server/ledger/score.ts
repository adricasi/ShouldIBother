import {
  calibrationBands,
  percentOf,
  type BandCount,
  type CalibrationBand,
} from "../../domain/calibration.js";
import { rankFor, type RankStanding } from "../../domain/ranks.js";
import { bandTable } from "../../domain/rules/index.js";
import type { SavingsTotals } from "../../domain/savings.js";

import { DEMO_MODEL } from "../demo.js";

import { syncAchievements, type AchievementView } from "./achievements.js";
import type { LedgerDeps } from "./deps.js";
import { luckyWinShare, type LuckyShare } from "./lucky.js";
import { pointsTotal } from "./points.js";
import { savingsTotals } from "./savings.js";

type ScoreDeps = Pick<LedgerDeps, "db" | "rules" | "flags" | "now" | "demo">;

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
  /** True in `sib demo`: every figure is sample data and the screen marks it (AC-029.4). */
  readonly demo: boolean;
  readonly points: { readonly total: number };
  /** The rank for the points total (AC-025.1); present only while the `ranks` flag is on. */
  readonly rank?: RankStanding;
  /** Every achievement, unlocked or not (AC-025.2); present only while the `ranks` flag is on. */
  readonly achievements?: readonly AchievementView[];
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
    /** Wins whose lucky flag is known; `share_pct` is whole percent, halves up. */
    readonly lucky_wins: LuckyShare & { readonly share_pct: number | null };
    /**
     * Settled do-nothing bets Gemma priced through the fake model. They are fixtures, not Gemma,
     * so they are not in Gemma's chart; the screen says so when that is why the chart is empty.
     */
    readonly fake_model_bets: number;
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
 * A model name that is a fixture, not Gemma. Outside `sib demo` every name starting `fake` is one;
 * in demo mode the demo model's own name (`fake-demo`) is counted, as labelled sample data
 * (NFR-010).
 */
function fixtureModel(column: string, demo: boolean | undefined): string {
  return demo === true
    ? `${column} LIKE 'fake%' AND ${column} NOT LIKE '${DEMO_MODEL}%'`
    : `${column} LIKE 'fake%'`;
}

/**
 * Gemma's population: bets priced by Gemma, counted under the band Gemma gave. A bet whose
 * model_version names the fake model is a fixture, not Gemma (decisions.ts), so it is left out
 * (the demo model's rows are kept in demo mode only).
 */
function gemmaPriced(demo: boolean | undefined): string {
  return `b.odds_source = 'gemma' AND b.gemma_band IS NOT NULL
  AND (b.model_version IS NULL OR NOT (${fixtureModel("b.model_version", demo)}))`;
}

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

/**
 * The first verdict of a bet is one the judge (Gemma) gave: its `decision_id` points at the logged
 * decision. A settlement without one has no Gemma verdict to agree or disagree with, and a verdict
 * of the fake model is a fixture, so neither is in the judge's N.
 */
function gemmaVerdict(demo: boolean | undefined): string {
  return `o.appeal_of IS NULL AND o.decision_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM gemma_decisions d WHERE d.id = o.decision_id AND NOT (${fixtureModel("d.model", demo)})
)`;
}

function overruleOf(deps: ScoreDeps): JudgeOverrule {
  if (!deps.flags.appeals) {
    return { appeals: "off" };
  }
  const verdict = gemmaVerdict(deps.demo);
  const n = deps.db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM bets b JOIN settlements o ON o.bet_id = b.id
       WHERE ${SETTLED_DO_NOTHING} AND ${verdict}`,
    )
    .get()!.n;
  // Any change of verdict is an overrule, as AC-023.3 reads: small loss to harmful loss included.
  const overruled = deps.db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM settlements a
       JOIN settlements o ON o.id = a.appeal_of
       JOIN bets b ON b.id = a.bet_id
       WHERE a.final = 1 AND ${SETTLED_DO_NOTHING} AND ${verdict} AND a.verdict != o.verdict`,
    )
    .get()!.n;
  return {
    appeals: "on",
    n,
    overruled,
    rate_pct: n === 0 ? null : percentOf(overruled, n),
  };
}

function fakeModelBets(deps: Pick<LedgerDeps, "db" | "demo">): number {
  return deps.db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM bets b
       WHERE ${SETTLED_DO_NOTHING} AND b.odds_source = 'gemma' AND b.gemma_band IS NOT NULL
         AND ${fixtureModel("b.model_version", deps.demo)}`,
    )
    .get()!.n;
}

/** The Score screen's numbers (REQ-020), read from the stored rows only. */
export function getScore(deps: ScoreDeps): Score {
  const table = bandTable(deps.rules);
  const gemma = countsBy(deps, "gemma_band", `AND ${gemmaPriced(deps.demo)}`);
  // The rule is scored on every settled do-nothing bet, whoever priced it (AC-020.2).
  const rule = countsBy(deps, "rule_band", "");
  const lucky = luckyWinShare(deps.db);
  const total = pointsTotal(deps);
  return {
    now: new Date(deps.now()).toISOString(),
    demo: deps.demo === true,
    points: { total },
    // Flagged (REQ-029): with `ranks` off the response has neither key, as before T-026.
    ...(deps.flags.ranks ? { rank: rankFor(total), achievements: syncAchievements(deps) } : {}),
    savings: savingsTotals(deps),
    judge: overruleOf(deps),
    calibration: {
      settled: rule.reduce((sum, entry) => sum + entry.n, 0),
      gemma: calibrationBands(table, gemma),
      rule: calibrationBands(table, rule),
      lucky_wins: {
        ...lucky,
        share_pct:
          lucky.wins_labelled === 0 ? null : percentOf(lucky.lucky_wins, lucky.wins_labelled),
      },
      fake_model_bets: fakeModelBets(deps),
    },
  };
}
