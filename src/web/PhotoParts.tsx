import { useId, type ChangeEvent } from "react";

import type { Card } from "./api.js";
import { Icon } from "./ui/Icon.js";
import { OddsMeter } from "./ui/OddsMeter.js";
import { PrivacyNote } from "./ui/PrivacyNote.js";

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
}: {
  label: string;
  busy: boolean;
  onPick: (file: File) => void;
  /** The privacy line under the button; off where several buttons share one line below them. */
  showPrivacy?: boolean;
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
      />
      <label htmlFor={inputId} className={`button secondary compact${busy ? " disabled" : ""}`}>
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
  if (actions === undefined) {
    return null;
  }
  if (photo === null) {
    return (
      <div className="photo-block">
        <PhotoPicker
          label="Add a photo for sharper odds"
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
      <img
        className="photo-thumb"
        src={photo.url}
        alt={`Your photo for ${card.title}`}
        width={96}
        height={96}
      />
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
