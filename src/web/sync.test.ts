import { describe, expect, it } from "vitest";

import { ApiError } from "./api.js";
import { afterSuccessfulPoll, describeError, type Notice } from "./notice.js";
import { createRefresher } from "./refresher.js";
import { ROUTE_TITLES, announceRoute, routeOf } from "./route.js";

/** A promise the test settles by hand, to order the answers of overlapping requests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const calls: ReturnType<typeof deferred<string>>[] = [];
  const shown: string[] = [];
  let notice: Notice | undefined;
  const refresh = createRefresher<string>({
    load: () => {
      const call = deferred<string>();
      calls.push(call);
      return call.promise;
    },
    apply: (data) => shown.push(data),
    setNotice: (update) => {
      notice = update(notice);
    },
  });
  return {
    calls,
    shown,
    refresh,
    getNotice: () => notice,
    setNotice: (next: Notice | undefined) => {
      notice = next;
    },
  };
}

describe("a poll cannot overwrite the state after an action (race)", () => {
  it("ignores a poll that started before the action's reload and answers after it", async () => {
    const h = harness();
    const poll = h.refresh(true); // started before the Undo
    const afterUndo = h.refresh(false); // the Undo's own reload
    h.calls[1]!.resolve("after undo");
    await afterUndo;
    h.calls[0]!.resolve("stale, bet still open");
    await poll;
    expect(h.shown).toEqual(["after undo"]);
  });

  it("shows the answers in order when nothing overlaps", async () => {
    const h = harness();
    const first = h.refresh(true);
    h.calls[0]!.resolve("one");
    await first;
    const second = h.refresh(true);
    h.calls[1]!.resolve("two");
    await second;
    expect(h.shown).toEqual(["one", "two"]);
  });

  it("ignores the failure of a superseded request as well", async () => {
    const h = harness();
    const poll = h.refresh(true);
    const action = h.refresh(false);
    h.calls[1]!.resolve("fresh");
    await action;
    h.calls[0]!.reject(new ApiError(0, "Can't reach the laptop."));
    await poll;
    expect(h.shown).toEqual(["fresh"]);
    expect(h.getNotice()).toBeUndefined();
  });
});

describe("a successful poll clears only poll errors", () => {
  it("keeps an action's error (409 on Undo, The odds changed) through a successful poll", async () => {
    const h = harness();
    h.setNotice(describeError(new ApiError(409, "The odds changed"), "action"));
    const poll = h.refresh(true);
    h.calls[0]!.resolve("data");
    await poll;
    expect(h.getNotice()).toMatchObject({ kind: "error", text: "The odds changed" });
  });

  it("clears the error an earlier poll raised, and keeps info notices", async () => {
    const h = harness();
    const failing = h.refresh(true);
    h.calls[0]!.reject(new ApiError(0, "Can't reach the laptop."));
    await failing;
    expect(h.getNotice()).toMatchObject({ kind: "error", origin: "poll" });
    const recovered = h.refresh(true);
    h.calls[1]!.resolve("data");
    await recovered;
    expect(h.getNotice()).toBeUndefined();

    h.setNotice({ kind: "info", text: "Bet placed.", origin: "action" });
    const again = h.refresh(true);
    h.calls[2]!.resolve("data");
    await again;
    expect(h.getNotice()).toMatchObject({ kind: "info", text: "Bet placed." });
  });

  it("a failed reload after an action is an action error, which a later poll leaves alone", async () => {
    const h = harness();
    const reload = h.refresh(false);
    h.calls[0]!.reject(new Error("boom"));
    await reload;
    expect(h.getNotice()).toMatchObject({
      origin: "action",
      text: "Something went wrong. Try again.",
    });
    expect(afterSuccessfulPoll(h.getNotice())).toBe(h.getNotice());
  });
});

describe("route change accessibility", () => {
  it("routeOf maps the hash to a screen, defaulting to Today", () => {
    expect(routeOf("#/slips")).toBe("slips");
    expect(routeOf("#/today")).toBe("today");
    expect(routeOf("")).toBe("today");
    expect(routeOf("#/unknown")).toBe("today");
  });

  it("announceRoute sets the title and focuses the new screen's heading", () => {
    const focused: string[] = [];
    const target = {
      title: "",
      querySelector: (selector: string) => ({ focus: () => focused.push(selector) }),
    };
    announceRoute("slips", target);
    expect(target.title).toBe(ROUTE_TITLES.slips);
    expect(focused).toEqual(["h1"]);
    announceRoute("today", target);
    expect(target.title).toBe(ROUTE_TITLES.today);
  });

  it("does not fail when the screen has no heading yet", () => {
    const target = { title: "", querySelector: () => null };
    expect(() => {
      announceRoute("today", target);
    }).not.toThrow();
    expect(target.title).toBe("Today · Should I Bother?");
  });
});
