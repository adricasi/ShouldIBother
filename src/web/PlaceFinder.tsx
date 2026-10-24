import { useId, useRef, useState, type KeyboardEvent } from "react";

import { ApiError, searchPlaces, type Place } from "./api.js";
import { Icon } from "./ui/Icon.js";

/** The search text is 2 to 60 characters (AC-024.4); the laptop checks it again. */
const SEARCH_MIN = 2;
const SEARCH_MAX = 60;
/** Control and invisible characters, which the laptop refuses too. */
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

/**
 * One position, a coarse one: no high accuracy (a neighbourhood is enough and the GPS chip stays
 * off), a 10 s wait, and a position up to 10 minutes old is fine.
 */
const LOCATE_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10_000,
  maximumAge: 600_000,
};

/** Rounded to 2 decimals (about 1 km) here, before anything is sent anywhere (AC-024.3). */
export function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * True where the browser can be asked for a position: a secure context (the laptop itself or an
 * https address) with the Geolocation API. On the plain-http Wi-Fi address of a phone it is false
 * and the button is not shown (AC-024.3).
 */
export function geolocationAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    "geolocation" in navigator
  );
}

/** "Gràcia, Barcelona": the name and its region, which is also the offered place label. */
export function placeTitle(place: Place): string {
  return place.admin1 === undefined || place.admin1 === place.name
    ? place.name
    : `${place.name}, ${place.admin1}`;
}

/** The polite words for each way a position can fail; all of them point to the search. */
function locateProblem(code: number): string {
  switch (code) {
    case 1:
      return "Your location was not shared, which is fine. Search for your place instead, or type the coordinates.";
    case 3:
      return "Finding your location took too long. Try again, search for your place instead, or type the coordinates.";
    default:
      return "This device could not work out where it is. Search for your place instead, or type the coordinates.";
  }
}

function searchProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return "That is a lot of searches in a minute. Please wait a moment, or type the coordinates.";
    }
    if (error.status === 503) {
      return "Search is offline; type the coordinates.";
    }
    return error.message;
  }
  return "Search is offline; type the coordinates.";
}

interface Message {
  readonly tone: "info" | "problem";
  readonly text: string;
}

export interface PlaceFinderProps {
  /** "Use my location" filled in a position, already rounded to 2 decimals. */
  readonly onLocated: (position: { latitude: number; longitude: number }) => void;
  /** A result was chosen. */
  readonly onChoose: (place: Place) => void;
}

/**
 * "Use my location" and the place search of onboarding (AC-024.3, AC-024.4). Both only fill in the
 * fields of the form for the person to check: nothing is saved here. The typed text lives in this
 * component's state only, goes to the laptop when the person presses Search, and is dropped after
 * a choice; it is never kept in the browser's storage.
 */
export function PlaceFinder({ onLocated, onChoose }: PlaceFinderProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly Place[]>([]);
  const [message, setMessage] = useState<Message | undefined>();
  const [busy, setBusy] = useState<"search" | "locate" | undefined>();
  const input = useRef<HTMLInputElement>(null);
  // Only the latest search may answer: an older one that comes back late is dropped.
  const latest = useRef(0);
  const helpId = useId();
  const statusId = useId();

  const locate = (): void => {
    const done = (next: Message): void => {
      setBusy(undefined);
      setMessage(next);
    };
    setBusy("locate");
    setMessage({ tone: "info", text: "Asking this device where it is…" });
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const latitude = roundToTwoDecimals(position.coords.latitude);
          const longitude = roundToTwoDecimals(position.coords.longitude);
          onLocated({ latitude, longitude });
          done({
            tone: "info",
            text: `Location filled in: ${String(latitude)}, ${String(longitude)}. Check it, then press Save.`,
          });
        },
        (error) => {
          done({ tone: "problem", text: locateProblem(error.code) });
        },
        LOCATE_OPTIONS,
      );
    } catch {
      done({ tone: "problem", text: locateProblem(2) });
    }
  };

  const search = async (): Promise<void> => {
    const text = query.trim();
    const length = [...text].length;
    if (length < SEARCH_MIN || length > SEARCH_MAX || HIDDEN.test(text)) {
      setResults([]);
      setMessage({
        tone: "problem",
        text: `Type ${String(SEARCH_MIN)} to ${String(SEARCH_MAX)} characters, for example a neighbourhood or a town.`,
      });
      input.current?.focus();
      return;
    }
    latest.current += 1;
    const ticket = latest.current;
    setBusy("search");
    setResults([]);
    setMessage({ tone: "info", text: "Searching…" });
    try {
      const found = await searchPlaces(text);
      if (ticket !== latest.current) {
        return;
      }
      setResults(found);
      setMessage(
        found.length === 0
          ? {
              tone: "info",
              text: "No places found. Try another spelling, or type the coordinates.",
            }
          : {
              tone: "info",
              text: `${String(found.length)} ${found.length === 1 ? "place" : "places"} found. Choose one.`,
            },
      );
    } catch (error) {
      if (ticket === latest.current) {
        setMessage({ tone: "problem", text: searchProblem(error) });
      }
    } finally {
      if (ticket === latest.current) {
        setBusy(undefined);
      }
    }
  };

  const choose = (place: Place): void => {
    latest.current += 1; // a search still on its way no longer matters
    setBusy(undefined);
    setResults([]);
    // The typed text is not kept once it has done its job.
    setQuery("");
    setMessage({
      tone: "info",
      text: `${placeTitle(place)} chosen. Check the place name, then press Save.`,
    });
    onChoose(place);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Enter searches; it must not save the whole form.
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void search();
    }
  };

  return (
    <div className="place-finder">
      {geolocationAvailable() ? (
        <button
          type="button"
          className="button secondary"
          disabled={busy === "locate"}
          onClick={locate}
        >
          <Icon name="pin" />
          Use my location
        </button>
      ) : null}
      <label htmlFor="onboarding-search">Search for a place</label>
      <div className="search-row">
        <input
          id="onboarding-search"
          ref={input}
          type="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={SEARCH_MAX}
          enterKeyHint="search"
          value={query}
          aria-describedby={`${helpId} ${statusId}`}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="button secondary"
          disabled={busy === "search"}
          onClick={() => {
            void search();
          }}
        >
          Search
        </button>
      </div>
      <p className="meta" id={helpId}>
        A town or neighbourhood. What you type is sent to Open-Meteo, only when you press Search.
      </p>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p
        id={statusId}
        role="status"
        className={message?.tone === "problem" ? "notice error" : "meta"}
      >
        {message?.text}
      </p>
      {results.length > 0 ? (
        <ul className="place-results" aria-label="Places found">
          {results.map((place) => (
            <li
              key={`${place.name}|${place.admin1 ?? ""}|${place.country}|${String(place.latitude)}|${String(place.longitude)}`}
            >
              <button
                type="button"
                className="place-result"
                onClick={() => {
                  choose(place);
                }}
              >
                <span className="place-result-title">{placeTitle(place)}</span>
                <span className="place-result-caption">
                  {place.country} · {String(place.latitude)}, {String(place.longitude)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
