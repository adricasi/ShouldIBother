import type { BandName } from "../server/gemma/bookmaker.js";
import type { ChoreType } from "../domain/chores.js";
import type { Verdict } from "../domain/points.js";

/**
 * The words of the sample data: what the scripted bookmaker and judge "say". Made up for the demo,
 * about weather in general; nothing here comes from a real household.
 */

type ByBand = Readonly<Record<BandName, string>>;

/** The bookmaker's one-line reason (at most 140 characters) per chore and band. */
export const BOOKMAKER_REASONS: Readonly<Record<ChoreType, ByBand>> = {
  plants: {
    very_unlikely: "Hot and dry all night: the pots will be thirsty by morning.",
    unlikely: "No rain in sight and it stays mild, so the soil will probably dry out.",
    toss_up: "A few light showers may arrive overnight; the pots could go either way.",
    likely: "A steady shower overnight should keep the pots moist until morning.",
    very_likely:
      "Heavy rain is forecast for most of the night, so the plants get watered for free.",
  },
  laundry_line: {
    very_unlikely: "Rain is due this afternoon, so the washing would not dry in time.",
    unlikely: "Muggy and still: a damp afternoon, the line will struggle.",
    toss_up: "Mild with a light breeze; the load should be nearly dry by six.",
    likely: "Fresh breeze and some sun, so the laundry should dry on the line.",
    very_likely: "Sunny, dry and breezy all day: the line will do the work of the dryer.",
  },
  laundry_tonight: {
    very_unlikely: "Rain is expected after midnight, so the laundry would be soaked by morning.",
    unlikely: "Still air and a heavy dew: the laundry would be damp at sunrise.",
    toss_up: "Dry night but little wind; the washing may feel slightly damp.",
    likely: "A dry, breezy night should leave the laundry dry by morning.",
    very_likely: "Breezy and dry until sunrise: the laundry will be ready by 08:00.",
  },
  ac: {
    very_unlikely: "A hot, still night above 28 degrees: skipping the AC will be uncomfortable.",
    unlikely: "The night stays warm, around 26 degrees, so sleeping may be hard without it.",
    toss_up: "A mild night near 24 degrees; some people will want the AC.",
    likely: "The night cools to about 22 degrees, which is fine to sleep without the AC.",
    very_likely: "A cool night below 20 degrees: the AC is not needed.",
  },
  heater: {
    very_unlikely: "A cold, grey day under 10 degrees: the flat will want some heat.",
    unlikely: "Cool all day, around 13 degrees, with little sun to warm the rooms.",
    toss_up: "A cool day near 16 degrees; sun on the balcony side may be enough.",
    likely: "A mild day close to 18 degrees: comfortable with a jumper.",
    very_likely: "Sunny and above 20 degrees: the heater can stay off.",
  },
};

type VerdictCopy = Readonly<Partial<Record<Verdict, readonly string[]>>>;

/** The judge's reason per chore and verdict. */
export const JUDGE_REASONS: Readonly<Record<ChoreType, VerdictCopy>> = {
  plants: {
    win: ["The soil is still moist, so skipping the watering worked."],
    normal_loss: ["The soil is dry, so the plants needed water after all."],
    harmful_loss: ["The leaves are drooping: the plants really needed water."],
    weather_would_have: ["Rain fell overnight, so the pots would have been watered anyway."],
    weather_would_not: ["It stayed dry, so the pots would have needed watering."],
  },
  laundry_line: {
    win: ["The washing dried on the line: the dryer stayed off."],
    small_loss: ["The washing is still damp, so it needed a short spin in the dryer."],
    normal_loss: ["The washing got wet, so it had to be dried indoors."],
    weather_would_have: ["Wet hours in the afternoon: the line would not have dried it."],
    weather_would_not: ["It stayed dry and breezy, so the line would have done the job."],
  },
  laundry_tonight: {
    win: ["The laundry is dry this morning: leaving it out was fine."],
    small_loss: ["The laundry is damp from the dew, so it needed another hour inside."],
    normal_loss: ["Rain wet the laundry overnight, so it had to be washed again."],
  },
  ac: {
    win: ["Slept fine without the AC, so skipping it worked."],
    small_loss: ["It was too warm and the AC went on, so the bet is lost."],
  },
  heater: {
    win: ["The flat stayed comfortable without the heater."],
    small_loss: ["It got too cold and the heater went on, so the bet is lost."],
  },
};

/** The weather line the judge quotes as its second piece of evidence. */
export const WEATHER_EVIDENCE: Readonly<Record<string, string>> = {
  rainy: "Recorded rain overnight",
  downpour: "Recorded rain 6 mm",
  showers: "Light recorded showers",
  breezy: "Dry, breezy hours",
  fresh: "Dry hours, light breeze",
  muggy: "Humid and still",
  mild: "Mild and dry",
  hot: "Hot and dry",
};
