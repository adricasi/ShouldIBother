import { isChoreType, type ChoreType } from "../../domain/chores.js";
import type { FlagName, Flags } from "../flags.js";
import { MAX_CAPTURE_CHARS, runListener, type ListenerChore } from "../gemma/listener.js";
import { HttpError } from "../problem.js";

import { createCards, type PlannedCard } from "./cards.js";
import type { LedgerDeps } from "./deps.js";
import type { CardView } from "./views.js";

export { MAX_CAPTURE_CHARS };

/** Chores of the version that are still behind a flag (REQ-029); their types read as "Coming later". */
const CHORE_FLAGS: Readonly<Partial<Record<string, FlagName>>> = {
  laundry_tonight: "laundryTonight",
  ac: "heater",
  heater: "heater",
};

/** The chore type of a listener chore this version offers, else undefined (AC-002.3). */
export function offeredChoreType(type: string, flags: Flags): ChoreType | undefined {
  if (!isChoreType(type)) {
    return undefined;
  }
  const flag = CHORE_FLAGS[type];
  return flag === undefined || flags[flag] ? type : undefined;
}

function planCard(chore: ListenerChore, flags: Flags): PlannedCard {
  if (chore.chore_type === "not_weather") {
    // AC-002.2: no weather link, so no odds and no bet action.
    return { kind: "not_weather", choreType: chore.chore_type, label: chore.label };
  }
  const offered = offeredChoreType(chore.chore_type, flags);
  if (offered === undefined) {
    // AC-002.3: a chore outside this version's list.
    return { kind: "coming_later", choreType: chore.chore_type, label: chore.label };
  }
  return { kind: "weather", choreType: offered, label: chore.label };
}

/**
 * Typed capture (AC-002.1): the listener finds the chores in a sentence and each becomes a card.
 * If Gemma is offline or its answer is invalid after the retry, no card is created and the
 * caller's text is untouched (AC-002.4); the quick chips still work without the listener.
 */
export async function captureText(deps: LedgerDeps, text: string): Promise<CardView[]> {
  const result = await runListener(deps.gemma, text);
  if (!result.ok) {
    if (result.failure === "invalid") {
      throw new HttpError(
        422,
        "Gemma couldn't read that, try rephrasing",
        "Your text is still in the box.",
      );
    }
    throw new HttpError(
      503,
      "Gemma is offline",
      "It could not read that right now. Use a chip below for rule odds, or try again.",
    );
  }
  return createCards(
    deps,
    result.output.chores.map((chore) => planCard(chore, deps.flags)),
  );
}
