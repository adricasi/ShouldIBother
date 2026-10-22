import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  answerCard,
  answerPlanNeed,
  captureCards,
  createQuickCard,
  deletePhoto,
  fetchScore,
  fetchSlips,
  fetchToday,
  followPlanAdvice,
  placeBet,
  retryCard,
  answerBetQuestion,
  settleBet,
  settleBetWithPhoto,
  undoBet,
  uploadPhoto,
  type BetKind,
  type Receipt,
  type Score,
  type SettleResult,
  type Slips,
  type Today,
} from "./api.js";
import type { Notice } from "./notice.js";
import { describeError } from "./notice.js";
import { createRefresher } from "./refresher.js";
import { announceRoute, redirectFor, routeOf, type Route } from "./route.js";
import { estimateServerNow, startPolling } from "./polling.js";
import { ScoreScreen } from "./ScoreScreen.js";
import { SlipsScreen } from "./SlipsScreen.js";
import { TodayScreen } from "./TodayScreen.js";

/** Countdowns are re-rendered this often between the 30 s polls. */
const CLOCK_TICK_MS = 15_000;
/** While Gemma is thinking about a card, Today is read this often so its odds appear promptly. */
const THINKING_POLL_MS = 3_000;

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
  // After a screen change, announce it: the title and focus move to the new heading.
  const shown = useRef(route);
  useEffect(() => {
    if (shown.current !== route) {
      shown.current = route;
      announceRoute(route, document);
    }
  }, [route]);
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
  const [score, setScore] = useState<Score | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [results, setResults] = useState<Record<number, Receipt>>({});
  const [busy, setBusy] = useState(false);
  const todayNow = useServerNow(today?.now);
  const slipsNow = useServerNow(slips?.now);

  /** Reloads Today and Slips; only the latest call's answer is shown (see `createRefresher`). */
  const refresh = useMemo(
    () =>
      createRefresher({
        load: () => Promise.all([fetchToday(), fetchSlips()]),
        apply: ([nextToday, nextSlips]) => {
          setToday(nextToday);
          setSlips(nextSlips);
        },
        setNotice,
      }),
    [],
  );

  // Both screens refresh every 30 s while the page is visible, and at once when it comes back.
  useEffect(
    () =>
      startPolling(() => {
        void refresh(true);
      }),
    [refresh],
  );

  // Score is read only while its screen is open, and only while the server has the flag on.
  const scoreOn = today?.flags["score"] === true;
  const showScore = route === "score" && (today === undefined || scoreOn);
  const redirect = redirectFor(route, today?.flags);
  useEffect(() => {
    if (redirect !== undefined) {
      window.location.replace(redirect);
    }
  }, [redirect]);
  const refreshScore = useMemo(
    () => createRefresher({ load: fetchScore, apply: setScore, setNotice }),
    [],
  );
  useEffect(() => {
    if (!showScore || !scoreOn) {
      return undefined;
    }
    return startPolling(() => {
      void refreshScore(true);
    });
  }, [showScore, scoreOn, refreshScore]);

  // A card Gemma is still working on is polled faster than the 30 s default (design.md, Interfaces).
  const gemmaIsThinking =
    today?.cards.some(
      (card) =>
        card.gemma?.state === "thinking" ||
        card.photo?.state === "inspecting" ||
        card.laundry_plan?.stage === "thinking",
    ) ?? false;
  useEffect(() => {
    if (!gemmaIsThinking) {
      return undefined;
    }
    return startPolling(
      () => {
        void refresh(true);
      },
      document,
      THINKING_POLL_MS,
    );
  }, [gemmaIsThinking, refresh]);

  /** Runs one action, then reloads so the screens show what the server now holds. */
  const act = useCallback(
    async (action: () => Promise<Notice | undefined>) => {
      setBusy(true);
      try {
        const result = await action();
        setNotice(result === undefined ? undefined : { ...result, origin: "action" });
      } catch (error) {
        setNotice(describeError(error, "action"));
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

  /** A verdict shows its receipt; a question or a saved answer waiting says so. */
  const afterSettle = (betId: number, result: SettleResult): Notice | undefined => {
    if (result.state === "settled") {
      setResults((previous) => ({ ...previous, [betId]: result.receipt }));
      return undefined;
    }
    if (result.state === "question") {
      return { kind: "info", text: "Gemma has a question. Answer it on the bet to settle." };
    }
    return { kind: "info", text: result.note };
  };

  const onSettle = (betId: number, answerId: string): void => {
    void act(async () => afterSettle(betId, await settleBet(betId, answerId)));
  };

  const onSettlePhoto = (betId: number, file: File): void => {
    void act(async () => afterSettle(betId, await settleBetWithPhoto(betId, file)));
  };

  const onSettleAnswer = (betId: number, yes: boolean): void => {
    void act(async () => afterSettle(betId, await answerBetQuestion(betId, yes)));
  };

  const onUndo = (betId: number): void => {
    void act(async () => {
      await undoBet(betId);
      return { kind: "info", text: "Undone. No points either way." };
    });
  };

  const reload = (): void => {
    void act(() => Promise.resolve(undefined));
  };

  if (showScore) {
    return (
      <ScoreScreen
        score={score}
        flags={today?.flags ?? {}}
        notice={notice}
        onReload={() => {
          void refreshScore(false);
        }}
      />
    );
  }
  if (route === "slips") {
    return (
      <SlipsScreen
        slips={slips}
        flags={today?.flags ?? {}}
        nowMs={slipsNow}
        busy={busy}
        notice={notice}
        onSettle={onSettle}
        onSettlePhoto={onSettlePhoto}
        onSettleAnswer={onSettleAnswer}
        onUndo={onUndo}
        onReload={reload}
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
      onCapture={async (text) => {
        let made = false;
        await act(async () => {
          await captureCards(text);
          made = true;
          return undefined;
        });
        return made;
      }}
      onRetry={(cardId) => {
        void act(async () => {
          await retryCard(cardId);
          return undefined;
        });
      }}
      onAnswer={(cardId, yes) => {
        void act(async () => {
          await answerCard(cardId, yes);
          return undefined;
        });
      }}
      onPhoto={(cardId, file) => {
        void act(async () => {
          await uploadPhoto(cardId, file);
          return undefined;
        });
      }}
      onDeletePhoto={(photoId) => {
        void act(async () => {
          await deletePhoto(photoId);
          return { kind: "info", text: "Photo deleted, with what Gemma read from it." };
        });
      }}
      onPlanNeed={(cardId, needed) => {
        void act(async () => {
          await answerPlanNeed(cardId, needed);
          return undefined;
        });
      }}
      onPlanFollow={(cardId) => {
        void act(async () => {
          await followPlanAdvice(cardId);
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
      onSettlePhoto={onSettlePhoto}
      onSettleAnswer={onSettleAnswer}
      onUndo={onUndo}
      onReload={reload}
    />
  );
}
