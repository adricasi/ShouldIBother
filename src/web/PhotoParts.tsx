import { useId, type ChangeEvent } from "react";

import { RAIN_CHORE_TYPES, type Card } from "./api.js";
import { Icon } from "./ui/Icon.js";
import { OddsMeter } from "./ui/OddsMeter.js";
import { PrivacyNote } from "./ui/PrivacyNote.js";
import "./slips.css";

export interface PhotoActions {
  readonly onPhoto: (cardId: number, file: File) => void;
  readonly onDeletePhoto: (photoId: string) => void;
}

/** Picks a photo with the phone's camera or gallery; the file is sent as soon as it is chosen. */
export function PhotoPicker({
  label,
  busy,
  onPick,
  showPrivacy = true,
  describedBy,
  variant = "button",
}: {
  label: string;
  busy: boolean;
  onPick: (file: File) => void;
  /** The privacy line under the button; off where several buttons share one line below them. */
  showPrivacy?: boolean;
  /** Id of the text that explains what the photo is for; read out with the picker. */
  describedBy?: string;
  /** How the label looks: a bordered button, a small pill (before photo) or a text link (after photo). */
  variant?: "button" | "pill" | "link";
}) {
  const inputId = useId();
  const change = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared so the same photo can be chosen again after a failed upload.
    event.target.value = "";
    if (file !== undefined) {
      onPick(file);
    }
  };
  return (
    <>
      <input
        id={inputId}
        className="photo-input"
        type="file"
        accept="image/*"
        disabled={busy}
        onChange={change}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
      />
      <label
        htmlFor={inputId}
        className={`button ${variant === "button" ? "secondary compact" : variant}${busy ? " disabled" : ""}`}
      >
        <Icon name="camera" />
        {label}
      </label>
      {showPrivacy ? <PrivacyNote /> : null}
    </>
  );
}

/**
 * The photo part of a bet slip (REQ-005): add a photo, "What Gemma saw" with the odds before →
 * after (AC-005.3), or Gemma's yes/no question when it could not tell (AC-005.4). Shown only on
 * cards with odds.
 */
export function PhotoBlock({
  card,
  busy,
  actions,
}: {
  card: Card;
  busy: boolean;
  actions: PhotoActions | undefined;
}) {
  const photo = card.photo ?? null;
  // A city rain bet takes no before photo: the inspector's observations do not fit (REQ-030).
  if (actions === undefined || RAIN_CHORE_TYPES.includes(card.chore_type)) {
    return null;
  }
  if (photo === null) {
    return (
      <div className="photo-block">
        <PhotoPicker
          label="Add a photo for sharper odds"
          variant="pill"
          busy={busy}
          onPick={(file) => {
            actions.onPhoto(card.id, file);
          }}
        />
      </div>
    );
  }
  return (
    <div className="photo-block">
      <figure className="photo-frame">
        <img
          className="photo-thumb"
          src={photo.url}
          alt={`Your photo for ${card.title}`}
          width={96}
          height={96}
        />
        <figcaption className="photo-chip">
          <Icon name="camera" /> Your photo
        </figcaption>
      </figure>
      {photo.state === "inspecting" ? (
        <p className="meta" role="status">
          {photo.note}
        </p>
      ) : null}
      {photo.odds_change === null ? null : (
        <OddsMeter
          before={photo.odds_change.before}
          after={photo.odds_change.after}
          text={photo.odds_change.text}
        />
      )}
      {photo.saw.length === 0 ? null : (
        <div className="saw">
          <p className="eyebrow leaf">
            <Icon name="sparkle" /> What Gemma saw
          </p>
          <dl>
            {photo.saw.map((item) => (
              <div key={item.name} className="saw-row">
                <dt>
                  <Icon name="check" />
                  {item.label}
                </dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {photo.question === null ? null : <p className="question">{photo.question}</p>}
      {photo.state !== "inspecting" && photo.note !== null ? (
        <p className="meta">{photo.note}</p>
      ) : null}
      <div className="photo-actions">
        {photo.state === "inspecting" ? null : (
          <PhotoPicker
            label="Send another photo"
            showPrivacy={false}
            busy={busy}
            onPick={(file) => {
              actions.onPhoto(card.id, file);
            }}
          />
        )}
        <button
          type="button"
          className="button secondary compact"
          disabled={busy}
          onClick={() => {
            actions.onDeletePhoto(photo.id);
          }}
        >
          Delete photo
        </button>
      </div>
      <PrivacyNote />
    </div>
  );
}
