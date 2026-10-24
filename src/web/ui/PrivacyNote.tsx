import { createContext, useContext, type ReactNode } from "react";

import { Icon } from "./Icon.js";

/** What the privacy line depends on: the `voice` flag, and where Gemma runs (AC-032.6). */
export interface PrivacyContextValue {
  readonly voice: boolean;
  /** Hosted mode: Gemma runs at DigitalOcean; `photos` says whether photos are sent there too. */
  readonly hosted: { readonly photos: boolean } | undefined;
}

const PrivacyContext = createContext<PrivacyContextValue>({ voice: false, hosted: undefined });

/**
 * Wraps a screen so every `PrivacyNote` inside knows the `voice` flag and the mode of
 * `/api/today`. Home mode, the default, is what it always was.
 */
export function PrivacyProvider({
  voice,
  mode,
  photos,
  children,
}: {
  readonly voice: boolean;
  readonly mode?: "home" | "hosted" | undefined;
  /** Whether photos can be sent at all; read only in hosted mode. */
  readonly photos?: boolean | undefined;
  readonly children: ReactNode;
}) {
  const value: PrivacyContextValue = {
    voice,
    hosted: mode === "hosted" ? { photos: photos !== false } : undefined,
  };
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

/** The hosted privacy line, word for word as AC-032.6 has it. */
export function hostedPrivacyText(photos: boolean): string {
  return photos
    ? "Gemma runs on DigitalOcean's inference service. Your chores, habits, answers, area forecast and the photos you add are sent there."
    : "Gemma runs on DigitalOcean's inference service. Your chores, habits, answers and area forecast are sent there. Photos are off.";
}

/** The privacy sentence for where a photo is taken; design-handoff §6 ("Gemma runs on your computer"). */
export function privacyText(voice: boolean, hosted?: PrivacyContextValue["hosted"]): string {
  if (hosted !== undefined) {
    return hostedPrivacyText(hosted.photos);
  }
  return `Gemma runs on your computer at home. Your photos${voice ? " and voice" : ""} never leave it.`;
}

/** Sits directly under a photo button. */
export function PrivacyNote() {
  const { voice, hosted } = useContext(PrivacyContext);
  return (
    <p className="meta privacy">
      <Icon name="lock" />
      {privacyText(voice, hosted)}
    </p>
  );
}

/** The standing privacy line of hosted mode, shown on Today even when no photo button exists. */
export function HostedPrivacyLine({ photos }: { readonly photos: boolean }) {
  return (
    <p className="meta privacy">
      <Icon name="lock" />
      {hostedPrivacyText(photos)}
    </p>
  );
}
