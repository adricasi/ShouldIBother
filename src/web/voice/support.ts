/** What the browser offers for recording; injectable so the rule is testable without a microphone. */
export interface VoiceEnvironment {
  readonly isSecureContext: boolean;
  readonly mediaDevices: { readonly getUserMedia?: unknown } | undefined;
  readonly hasMediaRecorder: boolean;
}

export function browserEnvironment(): VoiceEnvironment {
  return {
    isSecureContext: typeof window !== "undefined" && window.isSecureContext,
    mediaDevices: typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
  };
}

/**
 * Whether the mic button may be shown (AC-027.3). Browsers give the microphone only to a secure
 * context, so over plain HTTP on the home Wi-Fi `getUserMedia` is missing and the button is
 * hidden; the HTTPS option is Tailscale Serve (README). Typed capture is always there.
 */
export function micAvailable(env: VoiceEnvironment = browserEnvironment()): boolean {
  return (
    env.isSecureContext &&
    typeof env.mediaDevices?.getUserMedia === "function" &&
    env.hasMediaRecorder
  );
}
