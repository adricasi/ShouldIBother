import { join } from "node:path";

import { CHORES, type ChoreType } from "../domain/chores.js";
import type { DoNothingVerdict, DoItVerdict } from "../domain/points.js";
import { HOUR_MS, madridWallTime, madridWallTimeToEpochMs } from "../domain/time.js";
import type { Household } from "../server/config.js";
import type { Db } from "../server/db.js";
import { markDemoDataDir } from "../server/demo.js";
import type { Flags } from "../server/flags.js";
import { JobRunner } from "../server/gemma/runner.js";
import { HouseholdStore, applyPlaceLabel } from "../server/household-store.js";
import { Appealer } from "../server/ledger/appeal.js";
import { placeBet } from "../server/ledger/bets.js";
import { createChoreCard } from "../server/ledger/cards.js";
import { BackgroundTasks, type LedgerDeps } from "../server/ledger/deps.js";
import { cashOutBet } from "../server/ledger/rescue.js";
import { latestQuote } from "../server/ledger/quotes.js";
import { Settler } from "../server/ledger/settle.js";
import { PHOTOS_DIR, PhotoStore } from "../server/photos/store.js";
import { loadRules } from "../server/rules.js";
import { loadSavings } from "../server/savings.js";
import { FakeWeatherClient } from "../server/weather/fake.js";
import type { BandName } from "../server/gemma/bookmaker.js";

import { BOOKMAKER_REASONS, JUDGE_REASONS, WEATHER_EVIDENCE } from "./copy.js";
import { scenePhoto, type Scene } from "./images.js";
import { HISTORY, TODAY, profileOf, type BandCode, type End, type Row } from "./plan.js";
import { ScriptModel, type JudgeScript } from "./script-model.js";

/** The demo's "now": a fixed Friday morning, so every run shows the same thing. */
export const DEMO_NOW = madridWallTimeToEpochMs("2026-10-23", "10:00");

const BAND_NAMES: Readonly<Record<BandCode, BandName>> = {
  VU: "very_unlikely",
  U: "unlikely",
  T: "toss_up",
  L: "likely",
  VL: "very_likely",
};

/** The tap that gives each verdict (the chores' one-tap answers, REQ-008). */
const TAP_FOR: Readonly<Record<ChoreType, Readonly<Partial<Record<DoNothingVerdict, string>>>>> = {
  plants: { win: "moist", normal_loss: "dry", harmful_loss: "wilting" },
  laundry_line: { win: "line_dry", small_loss: "line_damp", normal_loss: "line_wet" },
  laundry_tonight: { win: "tonight_dry", small_loss: "tonight_damp", normal_loss: "tonight_wet" },
  ac: { win: "ac_fine", small_loss: "ac_warm" },
  heater: { win: "heater_fine", small_loss: "heater_cold" },
  car_rinse: { win: "car_clean", normal_loss: "car_dirty" },
  bike_rinse: { win: "bike_clean", normal_loss: "bike_dirty" },
  terrace_rinse: { win: "terrace_rinsed", normal_loss: "terrace_dirty" },
  rain_fill: { win: "fill_full", normal_loss: "fill_low" },
};

/** The sample household (made up; never `config/household.json`). */
export const SAMPLE_HOUSEHOLD: Household = {
  airConditioning: true,
  heaterThisSeason: true,
  dryer: "condenser",
  location: { latitude: 41.4, longitude: 2.16 },
  outdoorItems: ["balcony_plants", "clothes_line"],
};

/** The made-up place name on the weather board (AC-026.3). */
export const SAMPLE_PLACE_LABEL = "Sample flat";

export interface SeedSummary {
  readonly cards: number;
  readonly bets: number;
}

interface Pending {
  readonly at: number;
  readonly order: number;
  readonly run: () => Promise<void>;
}

function timeOf(row: Row): number {
  const [hour = "0", minute = "0"] = row.at.split(":");
  return madridWallTime(DEMO_NOW, -row.day, Number(hour), Number(minute));
}

function sceneFor(chore: ChoreType, verdict: DoNothingVerdict): Scene {
  const good = verdict === "win";
  return chore === "plants"
    ? good
      ? "plants_fine"
      : "plants_dry"
    : good
      ? "line_dry"
      : "line_wet";
}

/**
 * Fills the demo database through the real services, with a controlled clock, the fake weather and
 * the scripted model: cards and quotes from the bookmaker job, bets, settlements (tap, photo and
 * automatic), do-it decisions, cash-outs and appeals. Nothing is written with raw SQL.
 */
export async function seedDemoData(options: {
  readonly db: Db;
  readonly dataDir: string;
  readonly flags: Flags;
  /** Overrides the sample household's baseline in the config file (tests). */
  readonly baseline?: Household;
}): Promise<SeedSummary> {
  const { db, dataDir, flags } = options;
  const clock = { now: DEMO_NOW - 15 * 24 * HOUR_MS };
  const now = (): number => clock.now;
  const weather = new FakeWeatherClient(now);
  const model = new ScriptModel();
  const store = new HouseholdStore(db, options.baseline ?? SAMPLE_HOUSEHOLD, now);
  const ledger: LedgerDeps = {
    db,
    now,
    weather,
    gemma: new JobRunner({ model, db, now }),
    rules: loadRules(),
    get household() {
      return store.current();
    },
    flags,
    demo: true,
    savings: loadSavings(),
    photos: new PhotoStore(join(dataDir, PHOTOS_DIR)),
    background: new BackgroundTasks((error) => {
      throw error;
    }),
    log: () => undefined,
  };
  const settler = new Settler(ledger);
  const appealer = new Appealer(ledger);

  // The onboarding answers: the sample household, answered at the start of the two weeks.
  store.save(SAMPLE_HOUSEHOLD);
  applyPlaceLabel(db, SAMPLE_PLACE_LABEL);

  const queue: Pending[] = [];
  let order = 0;
  const later = (at: number, run: () => Promise<void>): void => {
    queue.push({ at, order: order++, run });
    queue.sort((a, b) => a.at - b.at || a.order - b.order);
  };

  let cards = 0;
  let bets = 0;

  const settleHoursFor = (chore: ChoreType, createdAt: number, late: number): number =>
    (CHORES[chore].settleBounds(createdAt).earliestMs - createdAt) / HOUR_MS + late;

  const place = async (row: Row, index: number): Promise<void> => {
    const createdAt = timeOf(row);
    clock.now = createdAt;
    weather.setProfile(profileOf(row.weather));
    model.judge = undefined;
    model.bookmaker =
      row.odds === "rule"
        ? "offline"
        : {
            band: BAND_NAMES[row.odds],
            reason: BOOKMAKER_REASONS[row.chore][BAND_NAMES[row.odds]],
            settleInHours: settleHoursFor(row.chore, createdAt, row.late ?? 0),
            ...(row.disagreement === undefined ? {} : { disagreement: row.disagreement }),
          };
    const view = await createChoreCard(ledger, row.chore);
    await ledger.background.idle();
    await ledger.gemma.idle();
    cards += 1;
    if (row.end.how === "card") {
      return;
    }
    const quote = latestQuote(ledger, view.id);
    const wanted = row.odds === "rule" ? "rule" : "gemma";
    if (view.kind !== "weather" || quote === undefined || quote.source !== wanted) {
      throw new Error(
        `Demo seed row ${String(index)} (${row.chore}, day ${String(row.day)} ${row.at}): expected a ${wanted} quote on a weather card, got ${view.kind} / ${quote?.source ?? "none"}`,
      );
    }
    const bet = placeBet(
      ledger,
      view.id,
      quote.id,
      row.end.how === "do_it" ? "do_it" : "do_nothing",
    );
    bets += 1;
    const settleAt = quote.settle_at;
    const answerAt = settleAt + (row.answerAfterMin ?? 20 + ((index * 37) % 80)) * 60_000;
    const end = row.end;
    switch (end.how) {
      case "tap":
      case "photo":
        later(answerAt, () => answer(row, bet.id, end, index));
        break;
      case "auto":
        later(settleAt + 25 * HOUR_MS, () => decideOnWeather(row, end.verdict));
        break;
      case "do_it":
        later(settleAt + 5 * 60_000, () => decideOnWeather(row, end.verdict));
        break;
      case "cash_out":
        later(createdAt + end.afterMin * 60_000, () => {
          cashOutBet(ledger, bet.id);
          return Promise.resolve();
        });
        break;
      case "open":
      case "due":
        break;
    }
  };

  const judgeFor = (
    row: Row,
    verdict: DoNothingVerdict | DoItVerdict,
    evidenceLine: string,
  ): JudgeScript => {
    const weatherLine = typeof row.weather === "string" ? WEATHER_EVIDENCE[row.weather] : undefined;
    const reasons = JUDGE_REASONS[row.chore][verdict];
    if (reasons === undefined) {
      throw new Error(`No judge copy for ${row.chore} / ${verdict}`);
    }
    return {
      verdict,
      reason: reasons[0] ?? "",
      evidence: [evidenceLine, ...(weatherLine === undefined ? [] : [weatherLine])],
    };
  };

  const answer = async (
    row: Row,
    betId: number,
    end: Extract<End, { how: "tap" | "photo" }>,
    index: number,
  ): Promise<void> => {
    if (end.how === "tap") {
      const answerId = TAP_FOR[row.chore][end.verdict];
      if (answerId === undefined) {
        throw new Error(`Demo seed row ${String(index)}: no tap for ${row.chore} / ${end.verdict}`);
      }
      const label = CHORES[row.chore].tapAnswers.find((a) => a.id === answerId)?.label ?? answerId;
      model.judge = judgeFor(row, end.verdict, `Tapped: ${label}`);
      const outcome = await settler.submitTap(betId, answerId);
      if (outcome.state !== "settled") {
        throw new Error(`Demo seed row ${String(index)} did not settle: ${outcome.state}`);
      }
    } else {
      const scene = end.scene ?? sceneFor(row.chore, end.verdict);
      model.judge = judgeFor(row, end.verdict, "After photo");
      const outcome = await settler.submitPhoto(betId, await scenePhoto(scene));
      if (outcome.state !== "settled") {
        throw new Error(`Demo seed row ${String(index)} did not settle: ${outcome.state}`);
      }
    }
    if (end.appeal !== undefined) {
      const appeal = end.appeal;
      later(clock.now + 45 * 60_000, async () => {
        model.judge = judgeFor(row, appeal.verdict, "New photo");
        await appealer.appeal(betId, await scenePhoto(appeal.scene));
      });
    }
  };

  const decideOnWeather = async (
    row: Row,
    verdict: DoNothingVerdict | DoItVerdict,
  ): Promise<void> => {
    model.judge = judgeFor(row, verdict, "Weather record only");
    const settled = await settler.runPass();
    if (settled !== 1) {
      throw new Error(`Demo seed: the weather pass settled ${String(settled)} bets, not 1`);
    }
  };

  const rows = [...HISTORY, ...TODAY];
  for (const [index, row] of rows.entries()) {
    later(timeOf(row), () => place(row, index));
  }
  while (queue.length > 0) {
    const next = queue.shift()!;
    clock.now = Math.max(clock.now, next.at);
    await next.run();
    await ledger.background.idle();
    await ledger.gemma.idle();
  }

  // The data folder is marked: `sib export` refuses it, and nothing here can pass for results.
  markDemoDataDir(dataDir);
  return { cards, bets };
}
