import { useId, type ChangeEvent } from "react";

import type { Card } from "./api.js";

export interface PhotoActions {
  readonly onPhoto: (cardId: number, file: File) => void;
  readonly onDeletePhoto: (photoId: string) => void;
}

/** Picks a photo with the phone's camera or gallery; the file is sent as soon as it is chosen. */
function PhotoPicker({
  label,
  busy,
  onPick,
}: {
  label: string;
  busy: boolean;
  onPick: (file: File) => void;
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
        {label}
      </label>
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
        <p
          className="odds-change"
          aria-label={`Odds changed from ${photo.odds_change.before} to ${photo.odds_change.after} percent`}
        >
          With the photo: {photo.odds_change.text}
        </p>
      )}
      {photo.saw.length === 0 ? null : (
        <div className="saw">
          <p className="eyebrow">What Gemma saw</p>
          <dl>
            {photo.saw.map((item) => (
              <div key={item.name} className="saw-row">
                <dt>{item.label}</dt>
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
    </div>
  );
}
