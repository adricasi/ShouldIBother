/**
 * The onboarding place search (AC-024.4): Open-Meteo's geocoding API, asked from the laptop and
 * never from the page. The text the person typed is the one string that leaves the laptop apart
 * from rounded coordinates; it is sent only for that search and is never logged (the HTTP layer
 * logs the path only), cached, stored, or part of a Gemma prompt or decision.
 *
 * TODO(builder): UNVERIFIED. Written without access to Open-Meteo (blocked in the build
 * environment; tests use a fake transport). Check each name below against the live API and its
 * documentation, then delete this note:
 *   - the path `/v1/search` on `geocoding-api.open-meteo.com`;
 *   - the query parameters `name`, `count`, `language` and `format=json`;
 *   - that `language` accepts `en`, `es` and `ca`, and that `count` accepts 10;
 *   - the answer: a `results` array (absent when nothing matches) of objects with `name`,
 *     `latitude`, `longitude`, `country` and (often) `admin1`.
 * This is the only file that knows those names.
 */

import { z } from "zod";

import {
  GEOCODE_MAX_RESULTS,
  type GeocodeLanguage,
  type PlaceResult,
} from "../../domain/geocode.js";
import { OPEN_METEO_HOSTS, roundCoordinate } from "../../domain/open-meteo.js";
import { hasControlOrInvisibleCharacters } from "../../domain/place-label.js";
import type { Db } from "../db.js";

import { PersistentCallCounter } from "./cache.js";
import { WeatherUnavailableError } from "./client.js";
import { OpenMeteoHttp, type OpenMeteoHttpOptions } from "./http.js";

/**
 * Searches a day (Madrid time). The place search has a budget of its own, kept in the same table
 * as the weather's, so a busy search session can never use up the 1,000 calls of the forecasts
 * and the settlement weather; once it is spent, searching says so and the coordinates are typed.
 */
export const GEOCODE_DAILY_CAP = 50;

/** Row prefix of the search's own daily count in `weather_cache` (`geocode-calls|YYYY-MM-DD`). */
const GEOCODE_COUNTER_PREFIX = "geocode-calls";

/** The HTTP layer of the place search: its own daily cap and one try, so a search is one call. */
export function createGeocodeHttp(
  db: Db,
  now: () => number,
  options: Omit<OpenMeteoHttpOptions, "counter" | "maxAttempts"> = {},
): OpenMeteoHttp {
  return new OpenMeteoHttp({
    ...options,
    counter: new PersistentCallCounter(db, now, GEOCODE_DAILY_CAP, GEOCODE_COUNTER_PREFIX),
    maxAttempts: 1,
  });
}

export const GEOCODE_URL = `https://${OPEN_METEO_HOSTS.geocoding}/v1/search`;

/** UNVERIFIED query parameter names and values (see the note at the top of the file). */
export const GEOCODE_QUERY = {
  text: "name",
  count: "count",
  language: "language",
  format: "format",
  formatValue: "json",
} as const;

/** Anything that can answer a place search: Open-Meteo, or the synthetic places of the demo. */
export interface Geocoder {
  /** At most 10 places; an empty list when nothing matches. Throws `WeatherUnavailableError`. */
  search(query: string, language: GeocodeLanguage): Promise<readonly PlaceResult[]>;
}

/** The shape read from the answer; everything else in it is ignored. */
const answerSchema = z.object({ results: z.array(z.unknown()).optional() });

const resultSchema = z.object({
  name: z.string().min(1).max(100),
  admin1: z.string().min(1).max(100).optional(),
  country: z.string().min(1).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * Reads the answer of the geocoding API. An answer of the wrong shape is an error (the service
 * is not behaving, so the search is "offline"); one result of the wrong shape, or with control or
 * invisible characters in a name, is left out. Coordinates are rounded to 2 decimals here, so the
 * page never holds a more precise place than a forecast request would use (NFR-002).
 */
export function parseGeocodeAnswer(body: unknown): PlaceResult[] {
  const answer = answerSchema.safeParse(body);
  if (!answer.success) {
    throw new WeatherUnavailableError("Open-Meteo geocoding answered something unexpected");
  }
  const places: PlaceResult[] = [];
  for (const candidate of answer.data.results ?? []) {
    const result = resultSchema.safeParse(candidate);
    if (!result.success) {
      continue;
    }
    const { name, admin1, country, latitude, longitude } = result.data;
    if ([name, admin1 ?? "", country].some(hasControlOrInvisibleCharacters)) {
      continue;
    }
    places.push({
      name,
      ...(admin1 === undefined ? {} : { admin1 }),
      country,
      latitude: roundCoordinate(latitude),
      longitude: roundCoordinate(longitude),
    });
    if (places.length === GEOCODE_MAX_RESULTS) {
      break;
    }
  }
  return places;
}

/** The URL of one search. Only here does the typed text enter a URL. */
export function geocodeUrl(query: string, language: GeocodeLanguage): string {
  const params = new URLSearchParams();
  params.set(GEOCODE_QUERY.text, query);
  params.set(GEOCODE_QUERY.count, String(GEOCODE_MAX_RESULTS));
  params.set(GEOCODE_QUERY.language, language);
  params.set(GEOCODE_QUERY.format, GEOCODE_QUERY.formatValue);
  return `${GEOCODE_URL}?${params.toString()}`;
}

/** The live geocoder, through the weather client's HTTP layer (allowlist, timeouts, call count). */
export class OpenMeteoGeocoder implements Geocoder {
  constructor(private readonly http: OpenMeteoHttp) {}

  async search(query: string, language: GeocodeLanguage): Promise<readonly PlaceResult[]> {
    return parseGeocodeAnswer(await this.http.getJson(geocodeUrl(query, language)));
  }
}
