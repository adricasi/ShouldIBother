import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import type { Onboarding, OnboardingAnswers } from "./api.js";
import { Nav } from "./Nav.js";
import type { Notice } from "./notice.js";
import "./onboarding.css";
import { PlaceFinder, placeTitle } from "./PlaceFinder.js";
import { Icon, type IconName } from "./ui/Icon.js";
import { NoticeBanner } from "./ui/NoticeBanner.js";
import { ErrorState, LoadingState } from "./ui/States.js";

export interface OnboardingScreenProps {
  /** Undefined until the first answer. */
  readonly onboarding: Onboarding | undefined;
  readonly flags: Readonly<Record<string, boolean>>;
  /** The raised voice button of the tab bar (flag `voice`, mic available); absent: plain tabs. */
  readonly fab?: ReactNode;
  readonly busy: boolean;
  readonly notice: Notice | undefined;
  /** The first screen of an empty app: no tab bar, the way out is Skip for now. */
  readonly firstRun?: boolean;
  readonly onSave: (answers: OnboardingAnswers) => void;
  /** Skip for now: the baseline in the config file stays in force (AC-024.2). */
  readonly onSkip: () => void;
  readonly onReload?: () => void;
}

const OUTDOOR_CHOICES = [
  {
    id: "balcony_plants",
    title: "Balcony plants",
    label: "Plants on a balcony or terrace",
    icon: "plant",
  },
  {
    id: "clothes_line",
    title: "Laundry line",
    label: "A clothes line or drying rack",
    icon: "shirt",
  },
  // The city rain bets' items (REQ-030): shown while the flag `rainChores` is on; no pricing effect.
  { id: "car", title: "Car", label: "A car on the street", icon: "car" },
  { id: "bike", title: "Bike", label: "A bike kept outside", icon: "bike" },
  {
    id: "terrace",
    title: "Terrace",
    label: "A terrace or outdoor furniture",
    icon: "terrace",
  },
  {
    id: "rain_barrel",
    title: "Rain barrel",
    label: "A rain barrel or bird bath",
    icon: "barrel",
  },
] as const satisfies readonly {
  id: string;
  title: string;
  label: string;
  icon: IconName;
}[];

const RAIN_ITEM_IDS: readonly string[] = ["car", "bike", "terrace", "rain_barrel"];

const DRYER_CHOICES = [
  { id: "none", label: "No dryer" },
  { id: "heat-pump", label: "Heat-pump dryer" },
  { id: "condenser", label: "Condenser dryer" },
  { id: "vented", label: "Vented dryer" },
] as const;

/** The longest place name, in code points (AC-026.3); the server refuses a longer one. */
const MAX_PLACE_LABEL = 40;

/** Cuts a typed place name to 40 code points, so an emoji is one character, not two. */
export function clampPlaceLabel(text: string): string {
  return [...text].slice(0, MAX_PLACE_LABEL).join("");
}

/** The privacy sentence for this screen: the answers stay home, only a rounded place goes out. */
export const ONBOARDING_PRIVACY_TEXT =
  "Your answers stay on your computer. Only your location, rounded to 2 decimals (about 1 km), goes to Open-Meteo to ask for the forecast.";

/** Plain decimals only: no hex, exponent, sign-plus or blanks inside (a comma counts as a point). */
const DECIMAL = /^-?\d+(?:[.,]\d+)?$/;

function parseCoordinate(text: string, limit: number): number | undefined {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed.replace(",", "."));
  return Math.abs(value) <= limit ? value : undefined;
}

/** The card on Today while onboarding is pending: ask, link to the form, or skip (AC-024.1/2). */
export function OnboardingPrompt({
  busy,
  onSkip,
}: {
  readonly busy: boolean;
  readonly onSkip: () => void;
}) {
  return (
    <section className="onboarding-prompt" aria-labelledby="onboarding-prompt-title">
      <h2 id="onboarding-prompt-title" className="section-title">
        Tell me about your home
      </h2>
      <p>
        What is outside your door, your dryer, whether you use the AC or the heater, and where you
        live. Savings are then measured against your own habits.
      </p>
      <div className="button-row">
        <a className="button primary" href="#/onboarding">
          Answer the questions
        </a>
        <button type="button" className="button secondary" disabled={busy} onClick={onSkip}>
          Skip for now
        </button>
      </div>
    </section>
  );
}

/** The sample "Today's card" board of the mockup: what a day of bets looks like. Decoration only. */
const SAMPLE_ROWS = [
  { name: "Laundry", odds: "70%" },
  { name: "Plants", odds: "35%" },
  { name: "Heater", odds: "NO BET" },
] as const;

function RaceBoard() {
  return (
    <div className="race-board" aria-hidden="true">
      <p className="race-title">Today&apos;s card · sample</p>
      <ul>
        {SAMPLE_ROWS.map((row) => (
          <li key={row.name}>
            <span className="race-name">{row.name}</span>
            <span className="race-leader" />
            <span className={`race-odds${row.odds === "NO BET" ? " none" : ""}`}>{row.odds}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A tile or row you tick: a real checkbox or radio covers it, so the whole surface is the target. */
function Choice({
  type,
  name,
  value,
  checked,
  onChange,
  title,
  caption,
  icon,
  layout,
}: {
  readonly type: "checkbox" | "radio";
  readonly name?: string;
  readonly value?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly title: string;
  readonly caption?: string;
  readonly icon?: IconName;
  readonly layout: "tile" | "row";
}) {
  return (
    <label className={`choice ${layout}`}>
      <input
        type={type}
        {...(name === undefined ? {} : { name })}
        {...(value === undefined ? {} : { value })}
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {icon === undefined ? null : (
        <span className="choice-icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
      )}
      <span className="choice-text">
        <span className="choice-title">{title}</span>
        {caption === undefined ? null : <span className="choice-caption">{caption}</span>}
      </span>
      <span className="choice-mark" aria-hidden="true">
        <Icon name="check" />
      </span>
    </label>
  );
}

function Form({
  initial,
  initialPlaceLabel,
  state,
  busy,
  rainChores,
  onSave,
  onSkip,
}: {
  readonly rainChores: boolean;
  readonly initial: Onboarding["household"];
  /** The optional place label stored with the answers (AC-026.3). */
  readonly initialPlaceLabel: string;
  readonly state: Onboarding["state"];
  readonly busy: boolean;
  readonly onSave: OnboardingScreenProps["onSave"];
  readonly onSkip: OnboardingScreenProps["onSkip"];
}) {
  const [outdoor, setOutdoor] = useState<readonly string[]>(initial.outdoorItems ?? []);
  const [dryer, setDryer] = useState<string>(initial.dryer);
  const [airConditioning, setAirConditioning] = useState(initial.airConditioning);
  const [heater, setHeater] = useState(initial.heaterThisSeason);
  const [latitude, setLatitude] = useState(String(initial.location.latitude));
  const [longitude, setLongitude] = useState(String(initial.location.longitude));
  const [placeLabel, setPlaceLabel] = useState(initialPlaceLabel);
  // Where the label came from: a name the person typed (or saved before) is never overwritten by
  // a search result; one a previous result offered may be replaced by the next, or cleared.
  const [labelFromResult, setLabelFromResult] = useState(false);
  const [editingPlace, setEditingPlace] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const latitudeBad = invalid && parseCoordinate(latitude, 90) === undefined;
  const longitudeBad = invalid && parseCoordinate(longitude, 180) === undefined;
  const latitudeInput = useRef<HTMLInputElement>(null);
  const longitudeInput = useRef<HTMLInputElement>(null);
  const placeFieldsId = useId();
  const placeInput = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const lat = parseCoordinate(latitude, 90);
    const lon = parseCoordinate(longitude, 180);
    if (lat === undefined || lon === undefined) {
      setInvalid(true);
      // The place fields may be folded away: open them first so the wrong one can take focus.
      flushSync(() => {
        setEditingPlace(true);
      });
      // The first wrong field gets the focus, so the error is not left behind a keyboard or reader.
      (lat === undefined ? latitudeInput : longitudeInput).current?.focus();
      return;
    }
    setInvalid(false);
    onSave({
      outdoorItems: OUTDOOR_CHOICES.filter((choice) => outdoor.includes(choice.id)).map(
        (choice) => choice.id,
      ),
      dryer: DRYER_CHOICES.find((choice) => choice.id === dryer)?.id ?? initial.dryer,
      airConditioning,
      heaterThisSeason: heater,
      location: { latitude: lat, longitude: lon },
      // Blank means none: left out, which the server reads as no label (AC-026.3).
      ...(placeLabel.trim() === "" ? {} : { place_label: placeLabel.trim() }),
    });
  };

  return (
    <form className="onboarding" onSubmit={submit} noValidate>
      <fieldset>
        <legend>What is outside your door?</legend>
        <div className="choice-grid">
          {OUTDOOR_CHOICES.filter((choice) => rainChores || !RAIN_ITEM_IDS.includes(choice.id)).map(
            (choice) => (
              <Choice
                key={choice.id}
                type="checkbox"
                layout="tile"
                title={choice.title}
                caption={choice.label}
                icon={choice.icon}
                checked={outdoor.includes(choice.id)}
                onChange={(checked) => {
                  setOutdoor((current) =>
                    checked ? [...current, choice.id] : current.filter((id) => id !== choice.id),
                  );
                }}
              />
            ),
          )}
        </div>
        <p className="meta">Used by upcoming features; nothing changes yet.</p>
      </fieldset>

      <fieldset>
        <legend>Your dryer</legend>
        <div className="choice-grid">
          {DRYER_CHOICES.map((choice) => (
            <Choice
              key={choice.id}
              type="radio"
              name="dryer"
              value={choice.id}
              layout="row"
              title={choice.label}
              checked={dryer === choice.id}
              onChange={() => {
                setDryer(choice.id);
              }}
            />
          ))}
        </div>
        <p className="meta">Line-drying is measured against this dryer.</p>
      </fieldset>

      <fieldset>
        <legend>Air conditioning and heating</legend>
        <div className="choice-stack">
          <Choice
            type="checkbox"
            layout="row"
            icon="thermo"
            title="I use air conditioning"
            checked={airConditioning}
            onChange={setAirConditioning}
          />
          <Choice
            type="checkbox"
            layout="row"
            icon="thermo"
            title="I heat the home this season"
            checked={heater}
            onChange={setHeater}
          />
        </div>
        <p className="meta">Skip the AC and skip the heater are offered only when you use them.</p>
      </fieldset>

      <fieldset>
        <legend>Where you live</legend>
        <div className="place-row">
          <Icon name="pin" />
          <span className="place-text">
            {placeLabel.trim() !== "" ? (
              <>
                {placeLabel.trim()}
                <span className="place-coords">
                  {" "}
                  {parseCoordinate(latitude, 90) === undefined ||
                  parseCoordinate(longitude, 180) === undefined
                    ? "Check the coordinates"
                    : `${latitude.trim()}, ${longitude.trim()}`}
                </span>
              </>
            ) : parseCoordinate(latitude, 90) === undefined ||
              parseCoordinate(longitude, 180) === undefined ? (
              "Check the coordinates"
            ) : (
              `${latitude.trim()}, ${longitude.trim()}`
            )}
          </span>
          <button
            type="button"
            className="place-change"
            aria-expanded={editingPlace}
            aria-controls={placeFieldsId}
            onClick={() => {
              setEditingPlace((open) => !open);
            }}
          >
            Change
          </button>
        </div>
        <div id={placeFieldsId} hidden={!editingPlace}>
          <PlaceFinder
            onLocated={(position) => {
              // Only the fields are filled in; nothing is saved until Save (AC-024.3).
              setLatitude(String(position.latitude));
              setLongitude(String(position.longitude));
              setInvalid(false);
              // A name offered by an earlier result no longer fits the new position.
              if (labelFromResult) {
                setPlaceLabel("");
                setLabelFromResult(false);
              }
            }}
            onChoose={(place) => {
              setLatitude(String(place.latitude));
              setLongitude(String(place.longitude));
              setInvalid(false);
              // The result's name is offered as the place label, to edit (AC-024.4), unless the
              // person typed one themselves.
              if (placeLabel.trim() === "" || labelFromResult) {
                setPlaceLabel(clampPlaceLabel(placeTitle(place)));
                setLabelFromResult(true);
              }
              placeInput.current?.focus();
            }}
          />
          <p className="meta" id="location-help">
            Or type it: neighbourhood level is enough. Latitude and longitude, for example 41.40 and
            2.16 for Gràcia, Barcelona.
          </p>
          <div className="coordinates">
            <label htmlFor="onboarding-place">Place name (optional)</label>
            <input
              id="onboarding-place"
              ref={placeInput}
              type="text"
              autoComplete="off"
              value={placeLabel}
              aria-describedby="place-help"
              onChange={(event) => {
                // 40 characters as the server counts them: code points, not UTF-16 units.
                setPlaceLabel(clampPlaceLabel(event.target.value));
                setLabelFromResult(false);
              }}
            />
            <p className="meta" id="place-help">
              Shown on the weather board, for example Gràcia · Barcelona. It stays on your computer
              and is never sent to the forecast service.
            </p>
            <label htmlFor="onboarding-latitude">Latitude</label>
            <input
              id="onboarding-latitude"
              ref={latitudeInput}
              type="text"
              inputMode="decimal"
              value={latitude}
              aria-describedby={latitudeBad ? "location-help location-error" : "location-help"}
              aria-invalid={latitudeBad}
              onChange={(event) => {
                setLatitude(event.target.value);
              }}
            />
            <label htmlFor="onboarding-longitude">Longitude</label>
            <input
              id="onboarding-longitude"
              ref={longitudeInput}
              type="text"
              inputMode="decimal"
              value={longitude}
              aria-describedby={longitudeBad ? "location-help location-error" : "location-help"}
              aria-invalid={longitudeBad}
              onChange={(event) => {
                setLongitude(event.target.value);
              }}
            />
          </div>
        </div>
        {invalid ? (
          <p className="notice error" role="alert" id="location-error">
            Latitude is a number from -90 to 90 and longitude from -180 to 180, with digits and one
            point, for example 41.40.
          </p>
        ) : null}
      </fieldset>

      <p className="meta privacy">
        <Icon name="lock" />
        {ONBOARDING_PRIVACY_TEXT}
      </p>
      <p className="meta">
        New bets use these answers. A bet already placed keeps the figures it was placed with.
      </p>

      <button type="submit" className="button primary" disabled={busy}>
        {state === "pending" ? "Start lazing" : "Save my answers"}
      </button>
      {state === "pending" ? (
        <button type="button" className="button secondary" disabled={busy} onClick={onSkip}>
          Skip for now
        </button>
      ) : null}
    </form>
  );
}

/**
 * The household questions (REQ-024), laid out like mockup 01: the sample race board, the headline,
 * outdoor tiles, the place row, the privacy line and "Start lazing". Shown on first open (alone,
 * `firstRun`) and again from the Household tab. A skip keeps the baseline in the config file
 * (AC-024.2).
 */
export function OnboardingScreen({
  onboarding,
  flags,
  busy,
  notice,
  firstRun = false,
  fab,
  onSave,
  onSkip,
  onReload,
}: OnboardingScreenProps) {
  const pending = onboarding?.state === "pending";
  return (
    <>
      <main className="screen onboarding-screen">
        <RaceBoard />
        <header className="onboarding-head">
          <h1 className="sr-only" tabIndex={-1}>
            Household
          </h1>
          <p className="eyebrow leaf">{pending ? "Takes about 30 seconds" : "Your home"}</p>
          <p className="headline">{pending ? "Let the sky do your chores." : "Your household"}</p>
          <p>
            {pending
              ? "Tell us what's outside. We'll bet on the weather doing the work, and pay you points when it does."
              : "Savings are measured against your own habits. Answer once; you can change it any time."}
          </p>
        </header>

        {onboarding === undefined && notice?.kind === "error" ? (
          <ErrorState title="Can't load your household" busy={busy} onRetry={onReload}>
            {notice.text}
          </ErrorState>
        ) : (
          <NoticeBanner notice={notice} />
        )}

        {onboarding === undefined ? (
          notice === undefined ? (
            <LoadingState />
          ) : null
        ) : (
          <Form
            // A saved or skipped answer starts the form again from what the server holds.
            key={`${onboarding.state}-${JSON.stringify(onboarding.household)}-${onboarding.place_label ?? ""}`}
            initial={onboarding.household}
            initialPlaceLabel={onboarding.place_label ?? ""}
            state={onboarding.state}
            busy={busy}
            rainChores={flags["rainChores"] === true}
            onSave={onSave}
            onSkip={onSkip}
          />
        )}
      </main>
      {firstRun ? null : <Nav flags={flags} current="onboarding" fab={fab} />}
    </>
  );
}
