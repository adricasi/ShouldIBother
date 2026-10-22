import { afterSuccessfulPoll, describeError, type Notice } from "./notice.js";

export interface RefresherOptions<T> {
  readonly load: () => Promise<T>;
  readonly apply: (data: T) => void;
  readonly setNotice: (update: (current: Notice | undefined) => Notice | undefined) => void;
}

/**
 * Reloads what the screens show. Every call takes a number; only the answer of the latest call is
 * used. Without that, a poll that started before an Undo or a settle could answer after the
 * action's own reload and put the old state back on the screen.
 */
export function createRefresher<T>(
  options: RefresherOptions<T>,
): (isPoll: boolean) => Promise<void> {
  let latest = 0;
  return async (isPoll) => {
    latest += 1;
    const mine = latest;
    try {
      const data = await options.load();
      if (mine !== latest) {
        return;
      }
      options.apply(data);
      if (isPoll) {
        options.setNotice(afterSuccessfulPoll);
      }
    } catch (error) {
      if (mine === latest) {
        const notice = describeError(error, isPoll ? "poll" : "action");
        options.setNotice(() => notice);
      }
    }
  };
}
