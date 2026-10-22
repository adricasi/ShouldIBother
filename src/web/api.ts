import { z } from "zod";

import { flagsSchema } from "./features.js";

const payoutsSchema = z.object({
  win_with_photo: z.number(),
  win_with_tap: z.number(),
  small_loss: z.number(),
  normal_loss: z.number(),
  harmful_loss: z.number(),
  do_it_if_not_needed: z.number(),
  do_it_if_needed: z.number(),
});

/** Savings totals with both parts of net time and the assumption behind each figure (REQ-011). */
export const savingsTotalsSchema = z.object({
  bets: z.number(),
  wins: z.number(),
  time_saved_s: z.number(),
  app_time_s: z.number(),
  net_time_s: z.number(),
  water_l: z.number(),
  electricity_kwh: z.number(),
  assumptions: z.array(
    z.object({
      chore_type: z.string(),
      assumption: z.string(),
      basis: z.string(),
      wins: z.number(),
    }),
  ),
});

const quoteSchema = z.object({
  id: z.number(),
  source: z.enum(["rule", "gemma"]),
  band: z.number(),
  band_name: z.string(),
  odds: z.number(),
  reason: z.string(),
  settle_at: z.string(),
  label: z.string(),
  provisional: z.boolean(),
  /** True when the odds were set with the card's photo (AC-005.3). */
  with_photo: z.boolean().optional(),
  payouts: payoutsSchema,
});

/** The card's before photo, with What Gemma saw and the odds before → after (REQ-005). */
export const photoSchema = z.object({
  id: z.string(),
  url: z.string(),
  state: z.enum(["inspecting", "seen", "unsure", "failed"]),
  /** "What Gemma saw" (AC-005.3). */
  saw: z.array(z.object({ name: z.string(), label: z.string(), value: z.string() })),
  /** Gemma's yes/no question when it could not tell from the photo (AC-005.4). */
  question: z.string().nullable(),
  note: z.string().nullable(),
  odds_change: z
    .object({
      before: z.number(),
      after: z.number(),
      before_band_name: z.string(),
      after_band_name: z.string(),
      text: z.string(),
    })
    .nullable(),
});

export const cardSchema = z.object({
  id: z.number(),
  chore_type: z.string(),
  title: z.string(),
  created_at: z.string(),
  kind: z.enum(["weather", "not_weather", "coming_later", "alert"]),
  /** Set on a "Do it now" alert; the card has no odds and no bet action (AC-012.1). */
  alert_reason: z.string().nullable(),
  /** Set on a card without odds that says why (AC-014.4, AC-016.4, AC-016.5). */
  notice: z.string().nullable(),
  /** Null on every card that cannot be bet on. */
  quote: quoteSchema.nullable(),
  /** Where the card stands with Gemma; null on a card that gets no Gemma quote (REQ-013). */
  gemma: z
    .object({
      state: z.enum(["thinking", "answered", "question", "offline"]),
      /** Gemma's yes/no question, answered with two taps (AC-003.3). */
      question: z.string().nullable(),
      /** Why Gemma has no answer, in plain words. */
      note: z.string().nullable(),
      can_retry: z.boolean(),
    })
    .nullable(),
  photo: photoSchema.nullish(),
});

const nullableNumber = z.number().nullable();

/** The recorded weather of a bet's window, in a few numbers (AC-008.1). */
export const weatherSchema = z.object({
  label: z.string(),
  digest: z.object({
    hours: z.number(),
    rain_mm: nullableNumber,
    wet_hours: nullableNumber,
    temp_min_c: nullableNumber,
    temp_max_c: nullableNumber,
    wind_max_kmh: nullableNumber,
    sunshine_h: nullableNumber,
  }),
  from: z.string(),
  to: z.string(),
});

/** Where a bet whose settle time has come stands (REQ-008); null before the settle time. */
export const settleSchema = z.object({
  state: z.enum(["answer_needed", "question", "waiting_weather", "waiting_gemma"]),
  note: z.string().nullable(),
  /** The judge's yes/no question (AC-008.5). */
  question: z.string().nullable(),
  answered_with: z.enum(["tap", "photo"]).nullable(),
  /** After this the judge settles the bet from the weather record alone (AC-008.7). */
  answer_until: z.string(),
  weather: weatherSchema.nullable(),
});

/** The PAID OUT receipt of a win, or the plain result of a loss or a do-it decision (REQ-010). */
export const receiptSchema = z.object({
  bet_id: z.number(),
  title: z.string(),
  kind: z.enum(["do_nothing", "do_it"]),
  outcome: z.enum(["paid_out", "loss", "do_it", "cash_out"]),
  verdict: z.string(),
  verdict_title: z.string(),
  stamp: z.string().nullable(),
  odds: z.number(),
  band_name: z.string(),
  points: z.number(),
  total_points: z.number(),
  multiplier: z.number(),
  multiplier_capped: z.boolean(),
  evidence: z.object({ kind: z.enum(["photo", "tap", "auto", "none"]), text: z.string() }),
  answer: z.string().nullable(),
  weather: weatherSchema.omit({ from: true, to: true }).nullable(),
  /** "Gemma's read" (AC-028.1). */
  gemma_read: z.object({ reason: z.string(), evidence: z.array(z.string()) }).nullable(),
  lucky_win: z.boolean().nullable(),
  message: z.string().nullable(),
  saved: z
    .object({
      time_min: z.number(),
      water_l: z.number(),
      electricity_kwh: z.number(),
      assumption: z.string(),
      basis: z.string(),
    })
    .nullable(),
  settled_at: z.string(),
});

/** The rescue alert and cash-out offer of a waiting bet; present only while `rescue` is on (REQ-022). */
export const rescueSchema = z.object({
  can_cash_out: z.boolean(),
  cash_out_points: z.number(),
  alert: z
    .object({
      text: z.string(),
      /** Null when only the safety backstop fired (the forecast did not cover the window). */
      rule_band: z.number().nullable(),
      rule_band_name: z.string().nullable(),
      rule_odds: z.number().nullable(),
      checked_at: z.string(),
      forecast_at: z.string(),
    })
    .nullable(),
  checked_at: z.string().nullable(),
});

export const betSchema = z.object({
  id: z.number(),
  card_id: z.number(),
  title: z.string(),
  kind: z.enum(["do_nothing", "do_it"]),
  band: z.number(),
  band_name: z.string(),
  odds: z.number(),
  odds_source: z.enum(["rule", "gemma"]),
  reason: z.string(),
  placed_at: z.string(),
  undo_until: z.string(),
  undoable: z.boolean(),
  settle_at: z.string(),
  status: z.string(),
  payouts: payoutsSchema,
  tap_answers: z.array(z.object({ id: z.string(), label: z.string() })),
  settle: settleSchema.nullable(),
  rescue: rescueSchema.optional(),
});

export const todaySchema = z.object({
  now: z.string(),
  flags: flagsSchema,
  points: z.object({ total: z.number() }),
  /** This week's savings, Monday to Sunday in Madrid time (AC-011.6). */
  week: z.object({ from: z.string(), to: z.string(), totals: savingsTotalsSchema }),
  /** Gemma's status, refreshed at least every 60 s (AC-013.5). */
  gemma: z.object({
    status: z.enum(["online", "waking", "offline"]),
    detail: z.string().nullable(),
    checked_at: z.string(),
  }),
  /** The forecast behind the odds: when it was fetched and how old that is (AC-014.3). */
  forecast: z
    .object({ fetched_at: z.string(), age_label: z.string(), stale: z.boolean() })
    .nullable(),
  /** Open-Meteo attribution, shown in the app (AC-014.6). */
  attribution: z.string(),
  cards: z.array(cardSchema),
  open_bets: z.array(betSchema),
  due_bets: z.array(betSchema),
});

export const slipsSchema = z.object({
  now: z.string(),
  settle_now: z.array(betSchema),
  waiting: z.array(betSchema.extend({ time_left_ms: z.number() })),
  settled: z.array(
    betSchema.extend({
      result: z.object({
        verdict: z.string(),
        points: z.number(),
        evidence: z.string(),
        settled_at: z.string(),
      }),
      receipt: receiptSchema,
    }),
  ),
});

const calibrationBandSchema = z.object({
  band: z.number(),
  name: z.string(),
  /** The odds the band stands for, in percent. */
  predicted_pct: z.number(),
  n: z.number(),
  wins: z.number(),
  /** Share of the band's bets where doing nothing worked; null with no bets. */
  actual_pct: z.number().nullable(),
  too_few: z.boolean(),
});

/** The Score screen: points, savings, judge overrule rate and band calibration (REQ-020). */
export const scoreSchema = z.object({
  now: z.string(),
  points: z.object({ total: z.number() }),
  savings: savingsTotalsSchema,
  judge: z.discriminatedUnion("appeals", [
    z.object({ appeals: z.literal("off") }),
    z.object({
      appeals: z.literal("on"),
      n: z.number(),
      overruled: z.number(),
      rate_pct: z.number().nullable(),
    }),
  ]),
  calibration: z.object({
    /** Settled do-nothing bets; zero shows the empty state (AC-020.4). */
    settled: z.number(),
    gemma: z.array(calibrationBandSchema),
    rule: z.array(calibrationBandSchema),
    lucky_wins: z.object({
      wins_labelled: z.number(),
      lucky_wins: z.number(),
      share: z.number().nullable(),
      /** Whole percent, halves up, computed from the counts. */
      share_pct: z.number().nullable(),
    }),
    /** Fixture bets of the fake model, left out of Gemma's chart. */
    fake_model_bets: z.number(),
  }),
});

/** What a settle request returns: a verdict, the judge's question, or a saved answer waiting. */
export const settleResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("settled"), receipt: receiptSchema }),
  z.object({ state: z.literal("question"), question: z.string() }),
  z.object({ state: z.literal("awaiting_weather"), note: z.string() }),
  z.object({ state: z.literal("awaiting_gemma"), note: z.string() }),
  z.object({ state: z.literal("answer_needed"), note: z.string() }),
]);

export type Score = z.infer<typeof scoreSchema>;
export type CalibrationBand = z.infer<typeof calibrationBandSchema>;
export type Card = z.infer<typeof cardSchema>;
export type CardPhoto = z.infer<typeof photoSchema>;
export type Bet = z.infer<typeof betSchema>;
export type Today = z.infer<typeof todaySchema>;
export type Slips = z.infer<typeof slipsSchema>;
export type BetKind = Bet["kind"];
export type Receipt = z.infer<typeof receiptSchema>;
export type SettleResult = z.infer<typeof settleResultSchema>;
export type SavingsTotals = z.infer<typeof savingsTotalsSchema>;
export type BetSettle = z.infer<typeof settleSchema>;
export type RecordedWeather = z.infer<typeof weatherSchema>;

/** A failed request: the server's RFC 9457 title and detail, or a plain network message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const problemSchema = z.object({ title: z.string(), detail: z.string().optional() });

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?:
    { method: "POST"; body: unknown } | { method: "POST"; form: FormData } | { method: "DELETE" },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...(init === undefined
        ? {}
        : init.method === "DELETE"
          ? { method: "DELETE" }
          : "form" in init
            ? // The browser sets the multipart boundary itself.
              { method: "POST", body: init.form }
            : {
                method: init.method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(init.body),
              }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the laptop. Check the Wi-Fi and try again.");
  }
  if (response.status === 401) {
    throw new ApiError(
      401,
      "This device is not paired. Open the pairing link shown on the laptop.",
    );
  }
  if (!response.ok) {
    const problem = problemSchema.safeParse(await response.json().catch(() => undefined));
    const text = problem.success
      ? [problem.data.title, problem.data.detail].filter(Boolean).join(": ")
      : `The laptop answered ${response.status}.`;
    throw new ApiError(response.status, text);
  }
  if (response.status === 204) {
    return schema.parse(undefined);
  }
  return schema.parse(await response.json());
}

export const fetchToday = (): Promise<Today> => request("/api/today", todaySchema);

export const createQuickCard = (choreType: string): Promise<Card> =>
  request("/api/cards/quick", cardSchema, {
    method: "POST",
    body: { chore_type: choreType },
  });

/** Typed capture: the listener turns a sentence into one card per chore (AC-002.1). */
export const captureCards = (text: string): Promise<Card[]> =>
  request("/api/cards", z.object({ cards: z.array(cardSchema) }), {
    method: "POST",
    body: { text },
  }).then((result) => result.cards);

/** Retry after "Gemma offline · rule odds" (AC-013.3). */
export const retryCard = (cardId: number): Promise<Card> =>
  request(`/api/cards/${cardId}/retry`, cardSchema, { method: "POST", body: {} });

/** The tap on Gemma's yes/no question (AC-003.3). */
export const answerCard = (cardId: number, yes: boolean): Promise<Card> =>
  request(`/api/cards/${cardId}/answer`, cardSchema, { method: "POST", body: { yes } });

/** Sends a before photo; Gemma then looks at it and the card is polled (AC-005.2). */
export const uploadPhoto = (cardId: number, file: File): Promise<Card> => {
  const form = new FormData();
  form.append("photo", file);
  return request(`/api/cards/${cardId}/photo`, z.object({ card: cardSchema }), {
    method: "POST",
    form,
  }).then((result) => result.card);
};

/** Deletes a photo and what was derived from it (AC-015.2). */
export const deletePhoto = (photoId: string): Promise<undefined> =>
  request(`/api/photos/${photoId}`, z.undefined(), { method: "DELETE" });

export const fetchScore = (): Promise<Score> => request("/api/score", scoreSchema);

export const fetchSlips = (): Promise<Slips> => request("/api/slips", slipsSchema);

/** `quoteId` is the quote the user is looking at; the server refuses if the card moved on. */
export const placeBet = (
  cardId: number,
  quoteId: number,
  kind: BetKind = "do_nothing",
): Promise<Bet> =>
  request("/api/bets", betSchema, {
    method: "POST",
    body: { card_id: cardId, quote_id: quoteId, kind },
  });

export const undoBet = (betId: number): Promise<Bet> =>
  request(`/api/bets/${betId}`, betSchema, { method: "DELETE" });

/** Folds an open bet at -10 points, no savings (AC-022.2); only exists while `rescue` is on. */
export const cashOutBet = (betId: number): Promise<{ receipt: Receipt }> =>
  request(
    `/api/bets/${betId}/cashout`,
    z.object({ state: z.literal("cashed_out"), receipt: receiptSchema }),
    { method: "POST", body: {} },
  );

/** One tap (AC-008.3). */
export const settleBet = (betId: number, answer: string): Promise<SettleResult> =>
  request(`/api/bets/${betId}/settle`, settleResultSchema, { method: "POST", body: { answer } });

/** An after photo, paid in full (AC-008.2). */
export const settleBetWithPhoto = (betId: number, file: File): Promise<SettleResult> => {
  const form = new FormData();
  form.append("photo", file);
  return request(`/api/bets/${betId}/settle`, settleResultSchema, { method: "POST", form });
};

/** The tap on the judge's yes/no question (AC-008.5). */
export const answerBetQuestion = (betId: number, yes: boolean): Promise<SettleResult> =>
  request(`/api/bets/${betId}/answer`, settleResultSchema, { method: "POST", body: { yes } });
