import { hasControlOrInvisibleCharacters } from "./place-label.js";

/** The place search takes 2 to 60 characters after trimming, counted in code points (AC-024.4). */
export const GEOCODE_QUERY_MIN = 2;
export const GEOCODE_QUERY_MAX = 60;
/** At most this many places are shown (AC-024.4). */
export const GEOCODE_MAX_RESULTS = 10;
/** At most this many searches per session and minute (AC-024.4). */
export const GEOCODE_SEARCHES_PER_MINUTE = 10;

/** The languages of the page (English, Spanish, Catalan); the search asks for place names in one. */
export const GEOCODE_LANGUAGES = ["en", "es", "ca"] as const;
export type GeocodeLanguage = (typeof GEOCODE_LANGUAGES)[number];
export const DEFAULT_GEOCODE_LANGUAGE: GeocodeLanguage = "en";

/** One place of the search, with coordinates already rounded to 2 decimals. */
export interface PlaceResult {
  readonly name: string;
  readonly admin1?: string;
  readonly country: string;
  readonly latitude: number;
  readonly longitude: number;
}

export type GeocodeQueryResult =
  { readonly ok: true; readonly query: string } | { readonly ok: false; readonly problem: string };

/**
 * Checks the text of a place search: trimmed, 2 to 60 code points, no control or invisible
 * characters (the place-label rule). The problem text never repeats the query, because the query
 * is not logged anywhere (AC-024.4).
 */
export function parseGeocodeQuery(text: unknown): GeocodeQueryResult {
  if (typeof text !== "string") {
    return { ok: false, problem: "Type the name of a place to search for." };
  }
  const query = text.trim();
  const length = [...query].length;
  if (length < GEOCODE_QUERY_MIN || length > GEOCODE_QUERY_MAX) {
    return {
      ok: false,
      problem: `A place name is ${GEOCODE_QUERY_MIN} to ${GEOCODE_QUERY_MAX} characters.`,
    };
  }
  if (hasControlOrInvisibleCharacters(query)) {
    return { ok: false, problem: "A place name cannot contain control or invisible characters." };
  }
  return { ok: true, query };
}

/**
 * The language of the page from an `Accept-Language` header: the first of English, Spanish and
 * Catalan by the person's own order of preference (q values), English when none is named.
 */
export function languageFromAcceptLanguage(header: string | undefined): GeocodeLanguage {
  if (header === undefined) {
    return DEFAULT_GEOCODE_LANGUAGE;
  }
  const preferences = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(parameter)?.[1])
        .find((value) => value !== undefined);
      return {
        primary: tag.trim().toLowerCase().split("-")[0] ?? "",
        quality: quality === undefined ? 1 : Number(quality),
        index,
      };
    })
    .filter((entry) => Number.isFinite(entry.quality) && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { primary } of preferences) {
    const language = GEOCODE_LANGUAGES.find((candidate) => candidate === primary);
    if (language !== undefined) {
      return language;
    }
  }
  return DEFAULT_GEOCODE_LANGUAGE;
}
