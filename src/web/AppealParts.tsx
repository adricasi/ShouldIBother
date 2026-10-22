import { useId } from "react";

import type { Receipt } from "./api.js";
import { formatPoints } from "./format.js";
import { PhotoPicker } from "./PhotoParts.js";
import { Icon } from "./ui/Icon.js";

/** The fixed words of an appeal (REQ-023); the second verdict is final and said so. */
export const APPEAL_COPY = {
  offer: "Gemma got it wrong? Send one new photo and it will look again.",
  button: "Appeal with a new photo",
  /** Said next to the offer when the appeal would come 24 h or more after the settle time. */
  half: "Appeals now pay at most half points.",
  working: "Gemma is re-judging…",
  final: "The second verdict is final. There is no second appeal.",
  changed: "The new photo changed the verdict.",
  confirmed: "The new photo confirmed the verdict.",
} as const;

/**
 * What an appealed bet shows on its receipt: the first verdict and its points, which the second
 * (final) verdict replaced, and whether it changed (AC-023.1, AC-023.3).
 */
export function AppealNote({ appeal }: { appeal: NonNullable<Receipt["appeal"]> }) {
  const { first } = appeal;
  return (
    <div className="appeal-note">
      <p className="eyebrow">
        <Icon name="camera" /> Appealed
      </p>
      <p>
        First verdict: {first.verdict_title} ({formatPoints(first.points)}).{" "}
        {appeal.changed ? APPEAL_COPY.changed : APPEAL_COPY.confirmed}
      </p>
      {first.reason === null ? null : <p className="meta">Gemma first said: {first.reason}</p>}
      <p className="meta">{APPEAL_COPY.final}</p>
    </div>
  );
}

/** The one appeal a settled bet gets: a photo picker, shown only where the server offers it. */
export function AppealAction({
  receipt,
  busy,
  working = false,
  onAppeal,
}: {
  receipt: Receipt;
  busy: boolean;
  /** This bet's appeal is being decided: Gemma is looking at the new photo. */
  working?: boolean;
  onAppeal: (betId: number, file: File) => void;
}) {
  const offerId = useId();
  if (receipt.can_appeal !== true) {
    return null;
  }
  return (
    <div className="appeal-action">
      <p className="meta" id={offerId}>
        {APPEAL_COPY.offer}
        {receipt.appeal_pays_half === true ? ` ${APPEAL_COPY.half}` : ""}
      </p>
      <PhotoPicker
        label={APPEAL_COPY.button}
        busy={busy}
        describedBy={offerId}
        onPick={(file) => {
          onAppeal(receipt.bet_id, file);
        }}
      />
      {working ? (
        <p className="meta" role="status">
          {APPEAL_COPY.working}
        </p>
      ) : null}
    </div>
  );
}
