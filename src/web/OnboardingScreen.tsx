import { useState, type FormEvent } from "react";

import type { Onboarding, OnboardingAnswers } from "./api.js";
import { Nav } from "./Nav.js";
import type { Notice } from "./notice.js";
import "./onboarding.css";
import { Icon } from "./ui/Icon.js";
import { NoticeBanner } from "./ui/NoticeBanner.js";
import { ErrorState, LoadingState } from "./ui/States.js";

export interface OnboardingScreenProps {
  /** Undefined until the first answer. */
  readonly onboarding: Onboarding | undefined;
  readonly flags: Readonly<Record<string, boolean>>;
  readonly busy: boolean;
  readonly notice: Notice | undefined;
  readonly onSave: (answers: OnboardingAnswers) => void;
  /** Skip for now: the baseline in the config file stays in force (AC-024.2). */
  readonly onSkip: () => void;
  readonly onReload?: () => void;
}

const OUTDOOR_CHOICES = [
  { id: "balcony_plants", label: "Plants on a balcony or terrace" },
  { id: "clothes_line", label: "A clothes line or drying rack" },
] as const;

const DRYER_CHOICES = [
  { id: "none", label: "No dryer" },
  { id: "heat-pump", label: "Heat-pump dryer" },
  { id: "condenser", label: "Condenser dryer" },
  { id: "vented", label: "Vented dryer" },
] as const;

/** The privacy sentence for this screen: the answers stay home, only a rounded place goes out. */
export const ONBOARDING_PRIVACY_TEXT =
  "Your answers stay on your computer. Only your location, rounded to 2 decimals (about 1 km), goes to Open-Meteo to ask for the forecast.";

function parseCoordinate(text: string, limit: number): number | undefined {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(value) && Math.abs(value) <= limit
    ? value
    : undefined;
}

function Form({
  initial,
  state,
  busy,
  onSave,
  onSkip,
}: {
  readonly initial: Onboarding["household"];
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
  const [invalid, setInvalid] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const lat = parseCoordinate(latitude, 90);
    const lon = parseCoordinate(longitude, 180);
    if (lat === undefined || lon === undefined) {
      setInvalid(true);
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
    });
  };

  return (
    <form className="onboarding" onSubmit={submit} noValidate>
      <fieldset>
        <legend>What is outside your door?</legend>
        {OUTDOOR_CHOICES.map((choice) => (
          <label key={choice.id} className="choice">
            <input
              type="checkbox"
              checked={outdoor.includes(choice.id)}
              onChange={(event) => {
                setOutdoor((current) =>
                  event.target.checked
                    ? [...current, choice.id]
                    : current.filter((id) => id !== choice.id),
                );
              }}
            />
            {choice.label}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Your dryer</legend>
        {DRYER_CHOICES.map((choice) => (
          <label key={choice.id} className="choice">
            <input
              type="radio"
              name="dryer"
              value={choice.id}
              checked={dryer === choice.id}
              onChange={() => {
                setDryer(choice.id);
              }}
            />
            {choice.label}
          </label>
        ))}
        <p className="meta">Line-drying is measured against this dryer.</p>
      </fieldset>

      <fieldset>
        <legend>Air conditioning and heating</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={airConditioning}
            onChange={(event) => {
              setAirConditioning(event.target.checked);
            }}
          />
          I use air conditioning
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={heater}
            onChange={(event) => {
              setHeater(event.target.checked);
            }}
          />
          I heat the home this season
        </label>
        <p className="meta">Skip the AC and skip the heater are offered only when you use them.</p>
      </fieldset>

      <fieldset>
        <legend>Where you live</legend>
        <p className="meta" id="location-help">
          Neighbourhood level is enough. Latitude and longitude, for example 41.40 and 2.16 for
          Gràcia, Barcelona.
        </p>
        <div className="coordinates">
          <label htmlFor="onboarding-latitude">Latitude</label>
          <input
            id="onboarding-latitude"
            type="text"
            inputMode="decimal"
            value={latitude}
            aria-describedby="location-help"
            aria-invalid={invalid && parseCoordinate(latitude, 90) === undefined}
            onChange={(event) => {
              setLatitude(event.target.value);
            }}
          />
          <label htmlFor="onboarding-longitude">Longitude</label>
          <input
            id="onboarding-longitude"
            type="text"
            inputMode="decimal"
            value={longitude}
            aria-describedby="location-help"
            aria-invalid={invalid && parseCoordinate(longitude, 180) === undefined}
            onChange={(event) => {
              setLongitude(event.target.value);
            }}
          />
        </div>
        {invalid ? (
          <p className="notice error" role="alert">
            Latitude is a number from -90 to 90 and longitude from -180 to 180.
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
        Save my answers
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
 * The household questions (REQ-024): shown on first open, and again from the Household tab. A
 * skip keeps the baseline in the config file (AC-024.2).
 */
export function OnboardingScreen({
  onboarding,
  flags,
  busy,
  notice,
  onSave,
  onSkip,
  onReload,
}: OnboardingScreenProps) {
  return (
    <>
      <main className="screen">
        <header className="header">
          <div>
            <p className="eyebrow">{onboarding?.state === "pending" ? "Welcome" : "Your home"}</p>
            <h1 tabIndex={-1}>Household</h1>
          </div>
        </header>
        <p>
          Savings are measured against your own habits. Answer once; you can change it any time.
        </p>

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
            key={`${onboarding.state}-${JSON.stringify(onboarding.household)}`}
            initial={onboarding.household}
            state={onboarding.state}
            busy={busy}
            onSave={onSave}
            onSkip={onSkip}
          />
        )}
      </main>
      <Nav flags={flags} current="onboarding" />
    </>
  );
}
