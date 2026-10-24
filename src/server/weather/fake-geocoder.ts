import { GEOCODE_MAX_RESULTS, type PlaceResult } from "../../domain/geocode.js";

import type { Geocoder } from "./geocoding.js";

/**
 * A few public places, synthetic and fixed, for the demo and the e2e run (`SIB_FAKE_WEATHER=1`):
 * the place search then needs no network. They are city and neighbourhood centres, not anyone's
 * home. Coordinates are already at 2 decimals.
 */
export const FAKE_PLACES: readonly PlaceResult[] = [
  { name: "Gràcia", admin1: "Barcelona", country: "Spain", latitude: 41.4, longitude: 2.16 },
  {
    name: "Madrid",
    admin1: "Community of Madrid",
    country: "Spain",
    latitude: 40.42,
    longitude: -3.7,
  },
  {
    name: "Valencia",
    admin1: "Valencian Community",
    country: "Spain",
    latitude: 39.47,
    longitude: -0.38,
  },
  { name: "Paris", admin1: "Île-de-France", country: "France", latitude: 48.85, longitude: 2.35 },
];

/** Lower case without accents, so "gracia" finds "Gràcia" and "ile" finds "Île-de-France". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a text, folded; commas and other punctuation separate them. */
function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** Answers from `FAKE_PLACES`: every place whose name, region or country holds the text. */
export class FakeGeocoder implements Geocoder {
  search(query: string): Promise<readonly PlaceResult[]> {
    const wanted = words(query);
    return Promise.resolve(
      FAKE_PLACES.filter((place) => {
        const haystack = fold([place.name, place.admin1 ?? "", place.country].join(" "));
        return wanted.length > 0 && wanted.every((word) => haystack.includes(word));
      }).slice(0, GEOCODE_MAX_RESULTS),
    );
  }
}
