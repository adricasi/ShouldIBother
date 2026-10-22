import { ApiError } from "./api.js";

/**
 * A message above the screen. `origin` says who raised it, so a background poll can clear only
 * its own errors and never the answer to something the person just did (a 409 on Undo, "The
 * odds changed").
 */
export interface Notice {
  readonly kind: "error" | "info";
  readonly text: string;
  readonly origin?: "poll" | "action";
}

export function describeError(error: unknown, origin: "poll" | "action"): Notice {
  return {
    kind: "error",
    text: error instanceof ApiError ? error.message : "Something went wrong. Try again.",
    origin,
  };
}

/** A poll that succeeds clears the error an earlier poll raised, and nothing else. */
export function afterSuccessfulPoll(current: Notice | undefined): Notice | undefined {
  return current?.kind === "error" && current.origin === "poll" ? undefined : current;
}
