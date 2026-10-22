import { createContext, useContext, type ReactNode } from "react";

import { Icon } from "./Icon.js";

/** Whether voice capture is on (flag `voice`): the note names voice only while it exists. */
const VoiceContext = createContext(false);

/** Wraps a screen so every `PrivacyNote` inside knows the `voice` flag of `/api/today`. */
export function PrivacyProvider({
  voice,
  children,
}: {
  readonly voice: boolean;
  readonly children: ReactNode;
}) {
  return <VoiceContext.Provider value={voice}>{children}</VoiceContext.Provider>;
}

/** The privacy sentence for where a photo is taken; design-handoff §6 ("Gemma runs on your computer"). */
export function privacyText(voice: boolean): string {
  return `Gemma runs on your computer at home. Your photos${voice ? " and voice" : ""} never leave it.`;
}

/** Sits directly under a photo button. */
export function PrivacyNote() {
  const voice = useContext(VoiceContext);
  return (
    <p className="meta privacy">
      <Icon name="lock" />
      {privacyText(voice)}
    </p>
  );
}
