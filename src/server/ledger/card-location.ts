import { roundCoordinate } from "../../domain/open-meteo.js";
import { DEFAULT_LOCATION } from "../config.js";
import type { WeatherLocation } from "../weather/client.js";

import type { LedgerDeps } from "./deps.js";

type LocationDeps = Pick<LedgerDeps, "db" | "flags" | "household">;

/**
 * Remembers where a new card was made (migration 0013), only while the `onboarding` flag is on:
 * with it off the location cannot change, and the rows stay what they were before the feature.
 * The household is read at the moment of the call, so the card carries the location of the moment
 * it was made. Written once; a trigger refuses a second write.
 */
export function stampCardLocation(deps: LocationDeps, cardId: number): void {
  if (!deps.flags.onboarding) {
    return;
  }
  const place = deps.household.location ?? DEFAULT_LOCATION;
  deps.db
    .prepare("UPDATE cards SET location_lat = ?, location_lon = ? WHERE id = ?")
    .run(roundCoordinate(place.latitude), roundCoordinate(place.longitude), cardId);
}

/**
 * The request fields that name the place a card was made under, to spread into a weather request.
 * Empty for an older card, or while the flag is off: the client then uses the current location.
 * A card stamped while the flag was on keeps its stamped place after the flag is turned off: the
 * stamp is the place it was priced for, and the flag only stops new stamps.
 */
export function cardLocationOf(card: {
  readonly location_lat: number | null;
  readonly location_lon: number | null;
}): { readonly location?: WeatherLocation } {
  return card.location_lat === null || card.location_lon === null
    ? {}
    : { location: { latitude: card.location_lat, longitude: card.location_lon } };
}

/** The same for the card behind a bet. */
export function betLocationOf(
  deps: Pick<LedgerDeps, "db">,
  betId: number,
): { readonly location?: WeatherLocation } {
  const row = deps.db
    .prepare<[number], { location_lat: number | null; location_lon: number | null }>(
      "SELECT c.location_lat, c.location_lon FROM bets b JOIN cards c ON c.id = b.card_id WHERE b.id = ?",
    )
    .get(betId);
  return row === undefined ? {} : cardLocationOf(row);
}
