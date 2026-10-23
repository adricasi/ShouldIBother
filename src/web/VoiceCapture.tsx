import { Mic } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import type { Card } from "./api.js";
import { realVoiceApi, VoiceSheet, type VoiceApi } from "./VoiceSheet.js";
import { createBrowserRecorder, type VoiceRecorder } from "./voice/recorder.js";
import { browserEnvironment, micAvailable, type VoiceEnvironment } from "./voice/support.js";

export interface VoiceCaptureProps {
  /** The `voice` flag from `/api/today`: off means no button and no sheet (AC-029.2). */
  readonly enabled: boolean;
  /** Cards were made from a voice note, after the person confirmed it (AC-027.1). */
  readonly onCards: (cards: Card[]) => void;
  readonly disabled?: boolean;
  /** Test seams; the app uses the browser's own. */
  readonly environment?: VoiceEnvironment;
  readonly createRecorder?: () => VoiceRecorder;
  readonly api?: VoiceApi;
}

function MicButton(props: VoiceCaptureProps) {
  const { onCards, disabled = false, createRecorder = createBrowserRecorder } = props;
  const [recorder, setRecorder] = useState<VoiceRecorder | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setRecorder(undefined);
    // Back to where the person was.
    button.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="button secondary voice-mic"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setRecorder(createRecorder());
        }}
      >
        <Mic className="icon" strokeWidth={1.8} aria-hidden="true" focusable="false" />
        <span className="voice-mic-label">Say your chores</span>
      </button>
      {recorder === undefined ? null : (
        <VoiceSheet
          recorder={recorder}
          api={props.api ?? realVoiceApi}
          onCards={onCards}
          onClose={close}
        />
      )}
    </>
  );
}

/**
 * The one entry point of voice capture (REQ-027): the capture bar mounts this and nothing else.
 * It renders nothing while the `voice` flag is off, or when the browser cannot record: no
 * microphone API, no secure context (always the case over plain HTTP on the LAN) or no
 * MediaRecorder. Typed capture is then all there is (AC-027.3).
 */
export function VoiceCapture(props: VoiceCaptureProps) {
  if (!props.enabled || !micAvailable(props.environment ?? browserEnvironment())) {
    return null;
  }
  return <MicButton {...props} />;
}
