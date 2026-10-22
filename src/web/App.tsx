import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  createQuickCard,
  fetchSlips,
  fetchToday,
  placeBet,
  settleBet,
  undoBet,
  type BetKind,
  type Settled,
  type Slips,
  type Today,
} from "./api.js";
import type { Route } from "./Nav.js";
import { estimateServerNow, startPolling } from "./polling.js";
import { SlipsScreen } from "./SlipsScreen.js";
import { TodayScreen, type Notice } from "./TodayScreen.js";

/** Countdowns are re-rendered this often between the 30 s polls. */
const CLOCK_TICK_MS = 15_000;

function describe(error: unknown): Notice {
  return {
    kind: "error",
    text: error instanceof ApiError ? error.message : "Something went wrong. Try again.",
  };
}

function routeOf(hash: string): Route {
  return hash === "#/slips" ? "slips" : "today";
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(routeOf(window.location.hash));
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  return route;
}

/** The server's clock, estimated from the last answer and re-read every few seconds. */
function useServerNow(serverNowIso: string | undefined): number {
  const base = useMemo(
    () => ({ serverMs: Date.parse(serverNowIso ?? new Date().toISOString()), localMs: Date.now() }),
    [serverNowIso],
  );
  const [localNow, setLocalNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setLocalNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return estimateServerNow(base, Math.max(localNow, base.localMs));
}

export function App() {
  const route = useRoute();
  const [today, setToday] = useState<Today | undefined>(undefined);
  const [slips, setSlips] = useState<Slips | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [results, setResults] = useState<Record<number, Settled>>({});
  const [busy, setBusy] = useState(false);
  const todayNow = useServerNow(today?.now);
  const slipsNow = useServerNow(slips?.now);

  /** Reloads Today and Slips. A poll that succeeds clears an old error; an action's reload keeps its notice. */
  const refresh = useCallback(async (isPoll: boolean) => {
    try {
      const [nextToday, nextSlips] = await Promise.all([fetchToday(), fetchSlips()]);
      setToday(nextToday);
      setSlips(nextSlips);
      if (isPoll) {
        setNotice((current) => (current?.kind === "error" ? undefined : current));
      }
    } catch (error) {
      setNotice(describe(error));
    }
  }, []);

  // Both screens refresh every 30 s while the page is visible, and at once when it comes back.
  useEffect(
    () =>
      startPolling(() => {
        void refresh(true);
      }),
    [refresh],
  );

  /** Runs one action, then reloads so the screens show what the server now holds. */
  const act = useCallback(
    async (action: () => Promise<Notice | undefined>) => {
      setBusy(true);
      try {
        setNotice(await action());
      } catch (error) {
        setNotice(describe(error));
      } finally {
        setBusy(false);
        await refresh(false);
      }
    },
    [refresh],
  );

  const place = (cardId: number, quoteId: number, kind: BetKind): void => {
    void act(async () => {
      await placeBet(cardId, quoteId, kind);
      return {
        kind: "info",
        text:
          kind === "do_it"
            ? "Noted: you will do it. It is scored when it settles. You can undo it for 5 minutes."
            : "Bet placed. It waits until its settle time. You can undo it for 5 minutes.",
      };
    });
  };

  const onSettle = (betId: number, answerId: string): void => {
    void act(async () => {
      const settled = await settleBet(betId, answerId);
      setResults((previous) => ({ ...previous, [betId]: settled }));
      return undefined;
    });
  };

  const onUndo = (betId: number): void => {
    void act(async () => {
      await undoBet(betId);
      return { kind: "info", text: "Undone. No points either way." };
    });
  };

  if (route === "slips") {
    return (
      <SlipsScreen
        slips={slips}
        flags={today?.flags ?? {}}
        nowMs={slipsNow}
        busy={busy}
        notice={notice}
        onSettle={onSettle}
        onUndo={onUndo}
      />
    );
  }
  return (
    <TodayScreen
      today={today}
      busy={busy}
      notice={notice}
      results={results}
      nowMs={todayNow}
      onQuickCard={(choreType) => {
        void act(async () => {
          await createQuickCard(choreType);
          return undefined;
        });
      }}
      onBet={(cardId, quoteId) => {
        place(cardId, quoteId, "do_nothing");
      }}
      onDoIt={(cardId, quoteId) => {
        place(cardId, quoteId, "do_it");
      }}
      onSettle={onSettle}
      onUndo={onUndo}
    />
  );
}
