import type { Achievement, BetSettle, Rank, Receipt, SavingsTotals, Score } from "./api.js";

/** Shared fixtures of the screen tests: synthetic values only. */
export const emptyTotals: SavingsTotals = {
  bets: 0,
  wins: 0,
  time_saved_s: 0,
  app_time_s: 0,
  net_time_s: 0,
  water_l: 0,
  electricity_kwh: 0,
  assumptions: [],
};

export const emptyWeek = {
  from: "2026-10-19",
  to: "2026-10-25",
  totals: emptyTotals,
};

export const weatherRecord = {
  label: "Modelled recent weather (Open-Meteo)",
  digest: {
    hours: 21,
    rain_mm: 3,
    wet_hours: 6,
    temp_min_c: 17,
    temp_max_c: 19,
    wind_max_kmh: 10,
    sunshine_h: 0.5,
  },
  from: "2026-10-22T08:00:00.000Z",
  to: "2026-10-23T06:00:00.000Z",
};

export const answerNeeded: BetSettle = {
  state: "answer_needed",
  note: null,
  question: null,
  answered_with: null,
  answer_until: "2026-10-24T06:00:00.000Z",
  weather: weatherRecord,
};

export const winReceipt: Receipt = {
  bet_id: 8,
  title: "Water plants",
  chore_type: "plants",
  kind: "do_nothing",
  outcome: "paid_out",
  verdict: "win",
  verdict_title: "You win",
  stamp: "PAID OUT",
  odds: 70,
  band_name: "likely",
  points: 15,
  total_points: 15,
  multiplier: 0.5,
  multiplier_capped: false,
  evidence: { kind: "tap", text: "One tap, paid at half" },
  answer: "Still moist, all fine",
  weather: { label: weatherRecord.label, digest: weatherRecord.digest },
  gemma_read: { reason: "Still moist.", evidence: ["Tapped: still moist"] },
  lucky_win: false,
  message: null,
  saved: {
    time_min: 5,
    water_l: 4,
    electricity_kwh: 0,
    assumption: "5 balcony pots: about 4 L of watering and 5 min skipped",
    basis: "typical estimate",
  },
  settled_at: "2026-10-23T06:05:00.000Z",
};

export const lossReceipt: Receipt = {
  ...winReceipt,
  bet_id: 9,
  outcome: "loss",
  verdict: "normal_loss",
  verdict_title: "Loss",
  stamp: null,
  points: -50,
  total_points: -35,
  gemma_read: { reason: "The soil is dry.", evidence: ["Tapped: soil is dry"] },
  lucky_win: null,
  message: "The weather did not cover this one, so the chore was still on.",
  saved: null,
};

const emptyBands: Score["calibration"]["gemma"] = [
  ["very unlikely", 15],
  ["unlikely", 35],
  ["toss-up", 50],
  ["likely", 70],
  ["very likely", 85],
].map(([name, predicted], band) => ({
  band,
  name: String(name),
  predicted_pct: Number(predicted),
  n: 0,
  wins: 0,
  actual_pct: null,
  too_few: true,
}));

/** A Score with nothing settled, appeals off and no rank (the `ranks` flag off). */
export const emptyScore: Score = {
  now: "2026-10-22T08:00:00.000Z",
  points: { total: 0 },
  savings: emptyTotals,
  judge: { appeals: "off" },
  calibration: {
    settled: 0,
    gemma: emptyBands,
    rule: emptyBands,
    lucky_wins: { wins_labelled: 0, lucky_wins: 0, share: null, share_pct: null },
    fake_model_bets: 0,
  },
};

export const koala: Rank = {
  id: "koala",
  name: "Koala",
  min_points: 200,
  next: { name: "Three-toed sloth", min_points: 600, points_to_go: 150 },
};

export const lockedAchievements: Achievement[] = [
  { id: "first_nap", name: "First nap", condition: "Win your first bet", unlocked_at: null },
  {
    id: "cloud_whisperer",
    name: "Cloud whisperer",
    condition: "Win a bet at odds of 40% or less",
    unlocked_at: null,
  },
  {
    id: "sky_freeloader",
    name: "Sky freeloader",
    condition: "Win three bets in a row",
    unlocked_at: null,
  },
  {
    id: "knows_when_to_fold",
    name: "Knows when to fold",
    condition: "Cash out for the first time",
    unlocked_at: null,
  },
];
